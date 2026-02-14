/**
 * Network capture module.
 *
 * Handles CDP Network domain events, stores captured requests in a ring buffer,
 * and provides query/filter capabilities.
 */

import type {
  CapturedRequest,
  CDPRequestWillBeSent,
  CDPResponseReceived,
  CDPLoadingFinished,
  NetworkFilter,
  RequestInitiator,
  RequestTiming,
  RedirectEntry,
  ResourceType,
  StackTrace,
  CDPStackTrace,
} from "./types.js";

export interface NetworkCaptureOptions {
  /** Maximum number of requests to store (ring buffer size) */
  maxRequests?: number;

  /** Maximum response body size to store (bytes). Larger bodies are truncated. */
  maxResponseBodySize?: number;

  /** URL patterns to exclude from capture (e.g., analytics, tracking) */
  excludePatterns?: RegExp[];
}

const DEFAULT_OPTIONS: Required<NetworkCaptureOptions> = {
  maxRequests: 1000,
  maxResponseBodySize: 512 * 1024, // 512KB
  excludePatterns: [],
};

/**
 * Stores and manages captured network requests.
 * Processes raw CDP events into structured CapturedRequest objects.
 */
export class NetworkCapture {
  private requests: Map<string, CapturedRequest> = new Map();
  private requestOrder: string[] = [];
  private nextIndex = 0;
  private options: Required<NetworkCaptureOptions>;

  /**
   * Offset to convert CDP monotonic timestamps to wall clock time.
   * Computed from the first requestWillBeSent event: wallTime - timestamp.
   */
  private timestampOffset: number | null = null;

  /** Pending requests awaiting response/body */
  private pending: Map<
    string,
    {
      request: Partial<CapturedRequest>;
      redirectChain: RedirectEntry[];
    }
  > = new Map();

  /** Callback for when a request completes */
  onRequestComplete?: (request: CapturedRequest) => void;

  constructor(options?: NetworkCaptureOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Convert CDP monotonic timestamp (seconds) to wall clock (ms since epoch) */
  private toWallTimeMs(cdpTimestamp: number): number {
    if (this.timestampOffset === null) return cdpTimestamp * 1000;
    return (cdpTimestamp + this.timestampOffset) * 1000;
  }

  // ── CDP Event Handlers ──

  /**
   * Handle Network.requestWillBeSent CDP event.
   * Creates a new pending request or records a redirect.
   */
  handleRequestWillBeSent(params: CDPRequestWillBeSent): void {
    if (this.shouldExclude(params.request.url)) return;

    // Compute timestamp offset on first event
    if (this.timestampOffset === null) {
      this.timestampOffset = params.wallTime - params.timestamp;
    }

    const existing = this.pending.get(params.requestId);

    if (params.redirectResponse && existing) {
      // This is a redirect — record the previous response in the chain
      existing.redirectChain.push({
        url: existing.request.url!,
        status: params.redirectResponse.status,
        headers: params.redirectResponse.headers,
      });

      // Update to new URL
      existing.request.url = params.request.url;
      existing.request.method = params.request.method;
      existing.request.requestHeaders = params.request.headers;
      existing.request.requestBody = params.request.postData;
      existing.request.timing = {
        ...existing.request.timing!,
        startTime: params.wallTime * 1000,
      };
      return;
    }

    // New request
    this.pending.set(params.requestId, {
      request: {
        id: params.requestId,
        index: this.nextIndex++,
        url: params.request.url,
        method: params.request.method,
        requestHeaders: params.request.headers,
        requestBody: params.request.postData,
        status: 0,
        statusText: "",
        responseHeaders: {},
        mimeType: "",
        responseSize: 0,
        resourceType: this.classifyResourceType(params.type),
        initiator: this.convertInitiator(params.initiator),
        timing: {
          startTime: params.wallTime * 1000,
        },
        redirectChain: [],
      },
      redirectChain: [],
    });

    // Detect preflight relationships
    if (
      params.initiator.type === "preflight" &&
      params.initiator.requestId
    ) {
      // Mark this preflight as being for the actual request
      const preflightEntry = this.pending.get(params.requestId);
      if (preflightEntry) {
        preflightEntry.request.preflightFor = params.initiator.requestId;
      }
      // Mark the actual request as having this preflight (check pending and completed)
      const actualPending = this.pending.get(params.initiator.requestId);
      if (actualPending) {
        actualPending.request.preflightRequestId = params.requestId;
      }
      const actualCompleted = this.requests.get(params.initiator.requestId);
      if (actualCompleted) {
        actualCompleted.preflightRequestId = params.requestId;
      }
    } else {
      // When processing a non-preflight request, check if any existing
      // preflight was waiting for this request ID
      for (const [id, entry] of this.pending) {
        if (entry.request.preflightFor === params.requestId) {
          const newEntry = this.pending.get(params.requestId);
          if (newEntry) {
            newEntry.request.preflightRequestId = id;
          }
          break;
        }
      }
      for (const [id, completed] of this.requests) {
        if (completed.preflightFor === params.requestId) {
          const newEntry = this.pending.get(params.requestId);
          if (newEntry) {
            newEntry.request.preflightRequestId = id;
          }
          break;
        }
      }
    }
  }

  /**
   * Handle Network.responseReceived CDP event.
   * Records response metadata on the pending request.
   */
  handleResponseReceived(params: CDPResponseReceived): void {
    const entry = this.pending.get(params.requestId);
    if (!entry) return;

    entry.request.status = params.response.status;
    entry.request.statusText = params.response.statusText;
    entry.request.responseHeaders = params.response.headers;
    entry.request.mimeType = params.response.mimeType;

    if (entry.request.timing) {
      entry.request.timing.responseTime = this.toWallTimeMs(params.timestamp);
    }

    // Update resource type if CDP provided one
    if (params.type) {
      entry.request.resourceType = this.classifyResourceType(params.type);
    }
  }

  /**
   * Handle Network.loadingFinished CDP event.
   * Finalizes the request and moves it to the completed store.
   */
  handleLoadingFinished(
    params: CDPLoadingFinished,
    getResponseBody?: (
      requestId: string
    ) => Promise<{ body: string; base64Encoded: boolean } | null>
  ): void {
    const entry = this.pending.get(params.requestId);
    if (!entry) return;

    entry.request.responseSize = params.encodedDataLength;

    if (entry.request.timing) {
      entry.request.timing.endTime = this.toWallTimeMs(params.timestamp);
      entry.request.timing.duration =
        entry.request.timing.endTime - entry.request.timing.startTime;
    }

    // Copy redirect chain
    entry.request.redirectChain = entry.redirectChain;

    // Fetch response body asynchronously if callback provided
    if (getResponseBody && this.shouldFetchBody(entry.request)) {
      getResponseBody(params.requestId)
        .then((result) => {
          if (result) {
            entry.request.responseBody = this.truncateBody(
              result.body,
              result.base64Encoded
            );
          }
          this.finalizeRequest(params.requestId, entry.request);
        })
        .catch(() => {
          this.finalizeRequest(params.requestId, entry.request);
        });
    } else {
      this.finalizeRequest(params.requestId, entry.request);
    }
  }

  /**
   * Handle Network.loadingFailed CDP event.
   * Records the failure and finalizes the request.
   */
  handleLoadingFailed(params: {
    requestId: string;
    errorText: string;
    timestamp: number;
  }): void {
    const entry = this.pending.get(params.requestId);
    if (!entry) return;

    if (entry.request.status === 0) {
      entry.request.status = 0;
      entry.request.statusText = params.errorText;
    }

    if (entry.request.timing) {
      entry.request.timing.endTime = this.toWallTimeMs(params.timestamp);
      entry.request.timing.duration =
        entry.request.timing.endTime - entry.request.timing.startTime;
    }

    entry.request.redirectChain = entry.redirectChain;
    this.finalizeRequest(params.requestId, entry.request);
  }

  // ── Query Methods ──

  /**
   * Get all captured requests, optionally filtered.
   */
  getRequests(filter?: NetworkFilter): CapturedRequest[] {
    let results = Array.from(this.requests.values());

    if (filter) {
      results = this.applyFilter(results, filter);
    }

    // Sort by index (chronological order)
    results.sort((a, b) => a.index - b.index);

    if (filter?.limit && results.length > filter.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /**
   * Get a single request by ID.
   */
  getRequest(requestId: string): CapturedRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Get requests that occurred after a specific timestamp.
   */
  getRequestsSince(timestampMs: number): CapturedRequest[] {
    return this.getRequests({ sinceTimestamp: timestampMs });
  }

  /**
   * Get total number of captured requests.
   */
  get size(): number {
    return this.requests.size;
  }

  /**
   * Get number of pending (incomplete) requests.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Clear all captured requests.
   */
  clear(): void {
    this.requests.clear();
    this.requestOrder = [];
    this.pending.clear();
    this.nextIndex = 0;
    this.timestampOffset = null;
  }

  // ── Internal Methods ──

  private finalizeRequest(
    requestId: string,
    partial: Partial<CapturedRequest>
  ): void {
    this.pending.delete(requestId);

    const request = partial as CapturedRequest;

    // Enforce ring buffer size
    if (this.requests.size >= this.options.maxRequests) {
      const oldest = this.requestOrder.shift();
      if (oldest) {
        this.requests.delete(oldest);
      }
    }

    this.requests.set(requestId, request);
    this.requestOrder.push(requestId);

    this.onRequestComplete?.(request);
  }

  private applyFilter(
    requests: CapturedRequest[],
    filter: NetworkFilter
  ): CapturedRequest[] {
    return requests.filter((req) => {
      if (filter.urlPattern) {
        try {
          const regex = new RegExp(filter.urlPattern, "i");
          if (!regex.test(req.url)) return false;
        } catch {
          // Invalid regex — treat as literal substring match
          if (!req.url.toLowerCase().includes(filter.urlPattern.toLowerCase()))
            return false;
        }
      }

      if (filter.method) {
        if (req.method.toUpperCase() !== filter.method.toUpperCase())
          return false;
      }

      if (filter.statusMin !== undefined) {
        if (req.status < filter.statusMin) return false;
      }

      if (filter.statusMax !== undefined) {
        if (req.status > filter.statusMax) return false;
      }

      if (filter.resourceType) {
        if (req.resourceType !== filter.resourceType) return false;
      }

      if (filter.sinceTimestamp !== undefined) {
        if (req.timing.startTime < filter.sinceTimestamp) return false;
      }

      return true;
    });
  }

  private shouldExclude(url: string): boolean {
    return this.options.excludePatterns.some((pattern) => pattern.test(url));
  }

  private shouldFetchBody(request: Partial<CapturedRequest>): boolean {
    const mime = request.mimeType || "";

    // Skip binary content
    if (
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      mime.includes("font") ||
      mime.includes("wasm")
    ) {
      return false;
    }

    return true;
  }

  private truncateBody(body: string, base64Encoded: boolean): string {
    if (base64Encoded) {
      return "[base64 encoded, " + body.length + " chars]";
    }

    if (body.length > this.options.maxResponseBodySize) {
      return (
        body.substring(0, this.options.maxResponseBodySize) +
        `\n... [truncated, ${body.length} total chars]`
      );
    }

    return body;
  }

  private convertInitiator(cdpInitiator: CDPRequestWillBeSent["initiator"]): RequestInitiator {
    return {
      type: cdpInitiator.type as RequestInitiator["type"],
      stack: cdpInitiator.stack
        ? this.convertStackTrace(cdpInitiator.stack)
        : undefined,
      url: cdpInitiator.url,
      lineNumber: cdpInitiator.lineNumber,
      columnNumber: cdpInitiator.columnNumber,
      requestId: cdpInitiator.requestId,
    };
  }

  private convertStackTrace(cdpStack: CDPStackTrace): StackTrace {
    return {
      description: cdpStack.description,
      callFrames: cdpStack.callFrames.map((f) => ({
        functionName: f.functionName,
        scriptId: f.scriptId,
        url: f.url,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
      })),
      parent: cdpStack.parent
        ? this.convertStackTrace(cdpStack.parent)
        : undefined,
    };
  }

  classifyResourceType(cdpType?: string): ResourceType {
    if (!cdpType) return "other";

    const typeMap: Record<string, ResourceType> = {
      XHR: "xhr",
      Fetch: "fetch",
      Document: "document",
      Stylesheet: "stylesheet",
      Script: "script",
      Image: "image",
      Font: "font",
      WebSocket: "websocket",
    };

    return typeMap[cdpType] || "other";
  }
}
