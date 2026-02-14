/**
 * Action-to-request correlation engine.
 *
 * The core differentiator: maps user actions (clicks, navigations, form submits)
 * to the network requests they triggered. Uses a layered approach:
 *
 * 1. Stack trace analysis (highest confidence, 0.90-0.95)
 * 2. Timing + semantic matching (medium confidence, 0.50-0.80)
 * 3. Timing proximity only (low confidence, 0.20-0.50)
 * 4. Chain membership (derived from an already-correlated parent)
 */

import type {
  CapturedRequest,
  TrackedAction,
  CorrelationResult,
  RequestChain,
  StackTrace,
} from "./types.js";

/** User-triggerable event types found in CDP async stack descriptions */
const USER_EVENT_TYPES = new Set([
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "submit",
  "input",
  "change",
  "keydown",
  "keyup",
  "keypress",
  "touchstart",
  "touchend",
  "pointerdown",
  "pointerup",
  "focus",
  "blur",
]);

/** URL patterns that indicate background/non-user-triggered requests */
const BACKGROUND_PATTERNS = [
  /analytics/i,
  /tracking/i,
  /telemetry/i,
  /heartbeat/i,
  /health/i,
  /ping/i,
  /beacon/i,
  /google-analytics/i,
  /gtag/i,
  /fbevents/i,
  /segment\.io/i,
  /hotjar/i,
  /sentry/i,
  /datadog/i,
  /newrelic/i,
];

export interface CorrelationOptions {
  /** Maximum time window (ms) for timing-based correlation */
  maxCorrelationWindow?: number;

  /** Minimum confidence threshold to accept a correlation */
  minConfidence?: number;

  /** Time to wait for network quiescence after an action (ms) */
  networkQuietPeriod?: number;
}

const DEFAULT_OPTIONS: Required<CorrelationOptions> = {
  maxCorrelationWindow: 2000,
  minConfidence: 0.2,
  networkQuietPeriod: 500,
};

export class Correlator {
  private actions: TrackedAction[] = [];
  private options: Required<CorrelationOptions>;

  constructor(options?: CorrelationOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Record a user action for later correlation.
   */
  recordAction(action: TrackedAction): void {
    this.actions.push(action);
  }

  /**
   * Get all recorded actions.
   */
  getActions(): TrackedAction[] {
    return [...this.actions];
  }

  /**
   * Get a specific action by ID.
   */
  getAction(actionId: string): TrackedAction | undefined {
    return this.actions.find((a) => a.id === actionId);
  }

  /**
   * Correlate a single request to its most likely triggering action.
   * Returns null if no correlation above the confidence threshold.
   */
  correlateRequest(
    request: CapturedRequest,
    allRequests: CapturedRequest[]
  ): {
    action: TrackedAction;
    confidence: number;
    method: CapturedRequest["correlationMethod"];
  } | null {
    // Layer 0: Preflight requests should inherit from their actual request
    if (request.initiator.type === "preflight" && request.initiator.requestId) {
      const chainMatch = this.matchByChain(request, allRequests);
      if (chainMatch) return chainMatch;
    }

    // Layer 1: Stack trace analysis
    const stackMatch = this.matchByStackTrace(request);
    if (stackMatch) {
      return {
        action: stackMatch.action,
        confidence: stackMatch.confidence,
        method: "stack_trace",
      };
    }

    // Layer 2 & 3: Timing + semantic matching
    const candidates = this.actions.filter((a) => {
      const delta = request.timing.startTime - a.timestamp;
      return delta >= -10 && delta <= this.options.maxCorrelationWindow;
    });

    if (candidates.length === 0) {
      // Layer 4: Check if this request is part of an existing chain
      return this.matchByChain(request, allRequests);
    }

    const scored = candidates
      .map((action) => ({
        action,
        confidence: this.computeScore(action, request),
      }))
      .filter((s) => s.confidence >= this.options.minConfidence)
      .sort((a, b) => b.confidence - a.confidence);

    if (scored.length === 0) return null;

    const best = scored[0];
    return {
      action: best.action,
      confidence: best.confidence,
      method: best.confidence >= 0.5 ? "timing_semantic" : "timing_only",
    };
  }

  /**
   * Correlate all requests for a specific action.
   * Returns a full CorrelationResult with chains detected.
   */
  correlateAction(
    actionId: string,
    allRequests: CapturedRequest[]
  ): CorrelationResult | null {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) return null;

    const correlated: CapturedRequest[] = [];
    let totalConfidence = 0;

    for (const request of allRequests) {
      const match = this.correlateRequest(request, allRequests);
      if (match && match.action.id === actionId) {
        request.correlatedActionId = actionId;
        request.correlationConfidence = match.confidence;
        request.correlationMethod = match.method;
        correlated.push(request);
        totalConfidence += match.confidence;
      }
    }

    if (correlated.length === 0) return null;

    // Sort by start time
    correlated.sort((a, b) => a.timing.startTime - b.timing.startTime);

    // Update action with resulting request IDs
    action.resultingRequestIds = correlated.map((r) => r.id);

    // Detect chains within the correlated requests
    const chains = this.detectChains(correlated);

    return {
      action,
      requests: correlated,
      chains,
      confidence: totalConfidence / correlated.length,
    };
  }

  /**
   * Bulk correlate: assign all uncorrelated requests to their best-matching actions.
   */
  correlateAll(requests: CapturedRequest[]): CorrelationResult[] {
    const results: Map<string, CorrelationResult> = new Map();

    for (const request of requests) {
      if (request.correlatedActionId) continue;

      const match = this.correlateRequest(request, requests);
      if (!match) continue;

      request.correlatedActionId = match.action.id;
      request.correlationConfidence = match.confidence;
      request.correlationMethod = match.method;

      if (!results.has(match.action.id)) {
        results.set(match.action.id, {
          action: match.action,
          requests: [],
          chains: [],
          confidence: 0,
        });
      }

      results.get(match.action.id)!.requests.push(request);
    }

    // Finalize each result
    for (const result of results.values()) {
      result.requests.sort((a, b) => a.timing.startTime - b.timing.startTime);
      result.action.resultingRequestIds = result.requests.map((r) => r.id);
      result.chains = this.detectChains(result.requests);
      result.confidence =
        result.requests.reduce(
          (sum, r) => sum + (r.correlationConfidence || 0),
          0
        ) / result.requests.length;
    }

    return Array.from(results.values()).sort(
      (a, b) => a.action.timestamp - b.action.timestamp
    );
  }

  /**
   * Clear all recorded actions.
   */
  clear(): void {
    this.actions = [];
  }

  // ── Stack Trace Analysis (Layer 1) ──

  private matchByStackTrace(
    request: CapturedRequest
  ): { action: TrackedAction; confidence: number } | null {
    if (!request.initiator.stack) return null;

    const eventOrigin = this.extractEventOrigin(request.initiator.stack);
    if (!eventOrigin) return null;

    // Find an action that matches this event type and timing
    const candidates = this.actions.filter((action) => {
      // Event type should match action type
      const eventMatchesAction =
        (eventOrigin.eventType === "click" && action.type === "click") ||
        (eventOrigin.eventType === "submit" && action.type === "submit") ||
        (["input", "change", "keydown"].includes(eventOrigin.eventType) &&
          action.type === "type") ||
        (eventOrigin.eventType === "submit" && action.type === "navigate");

      if (!eventMatchesAction) return false;

      // Timing should be close
      const delta = request.timing.startTime - action.timestamp;
      return delta >= -10 && delta <= this.options.maxCorrelationWindow;
    });

    if (candidates.length === 0) return null;

    // Pick the closest action by time
    const closest = candidates.reduce((best, current) => {
      const bestDelta = Math.abs(
        request.timing.startTime - best.timestamp
      );
      const currentDelta = Math.abs(
        request.timing.startTime - current.timestamp
      );
      return currentDelta < bestDelta ? current : best;
    });

    // Confidence based on async depth (fewer hops = more confident)
    const confidence = Math.max(
      0.85,
      0.95 - eventOrigin.asyncDepth * 0.02
    );

    return { action: closest, confidence };
  }

  /**
   * Walk the async stack trace to find the originating user event.
   */
  extractEventOrigin(
    stack: StackTrace
  ): { eventType: string; asyncDepth: number } | null {
    let current: StackTrace | undefined = stack;
    let depth = 0;
    const maxDepth = 50;

    while (current && depth < maxDepth) {
      if (
        current.description &&
        USER_EVENT_TYPES.has(current.description.toLowerCase())
      ) {
        return {
          eventType: current.description.toLowerCase(),
          asyncDepth: depth,
        };
      }
      current = current.parent;
      depth++;
    }

    return null;
  }

  // ── Timing + Semantic Scoring (Layer 2 & 3) ──

  private computeScore(
    action: TrackedAction,
    request: CapturedRequest
  ): number {
    let score = 0;
    const deltaMs = request.timing.startTime - action.timestamp;

    // Time proximity (0 to 0.35)
    // Exponential decay: 0-50ms scores ~0.35, 500ms scores ~0.03
    score += 0.35 * Math.exp(-deltaMs / 150);

    // Semantic matching (0 to 0.45)
    score += this.semanticScore(action, request);

    // Background penalty
    if (this.isLikelyBackground(request)) {
      score -= 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  private semanticScore(
    action: TrackedAction,
    request: CapturedRequest
  ): number {
    let score = 0;
    const url = request.url.toLowerCase();
    const method = request.method;
    const description = action.targetDescription.toLowerCase();

    // Navigate action + document request
    if (action.type === "navigate" && request.resourceType === "document") {
      score += 0.35;
    }

    // Submit action + POST request
    if (action.type === "submit" && method === "POST") {
      score += 0.25;
    }

    // Click action + XHR/Fetch request
    if (
      action.type === "click" &&
      (request.resourceType === "xhr" || request.resourceType === "fetch")
    ) {
      score += 0.15;
    }

    // Text-URL pattern matching
    const patterns: Array<{
      text: RegExp;
      url: RegExp;
      method: string | null;
      bonus: number;
    }> = [
      {
        text: /login|sign.?in/,
        url: /auth|login|sign.?in|session/,
        method: "POST",
        bonus: 0.3,
      },
      {
        text: /register|sign.?up/,
        url: /register|sign.?up|user/,
        method: "POST",
        bonus: 0.3,
      },
      {
        text: /save|update|submit/,
        url: /./,
        method: "POST",
        bonus: 0.15,
      },
      {
        text: /delete|remove/,
        url: /./,
        method: "DELETE",
        bonus: 0.25,
      },
      {
        text: /search/,
        url: /search|query|find/,
        method: "GET",
        bonus: 0.25,
      },
      {
        text: /load.?more|next/,
        url: /page|offset|cursor|limit/,
        method: "GET",
        bonus: 0.2,
      },
      {
        text: /logout|sign.?out/,
        url: /logout|sign.?out|session/,
        method: null,
        bonus: 0.3,
      },
    ];

    for (const pattern of patterns) {
      if (pattern.text.test(description) && pattern.url.test(url)) {
        if (!pattern.method || pattern.method === method) {
          score += pattern.bonus;
          break;
        }
      }
    }

    return score;
  }

  // ── Chain Detection (Layer 4) ──

  private matchByChain(
    request: CapturedRequest,
    allRequests: CapturedRequest[]
  ): {
    action: TrackedAction;
    confidence: number;
    method: CapturedRequest["correlationMethod"];
  } | null {
    // Check if this request's initiator references a request that is already correlated
    if (request.initiator.type === "preflight" && request.initiator.requestId) {
      const parent = allRequests.find(
        (r) => r.id === request.initiator.requestId
      );
      if (parent?.correlatedActionId) {
        const action = this.actions.find(
          (a) => a.id === parent.correlatedActionId
        );
        if (action) {
          return { action, confidence: 0.85, method: "chain" };
        }
      }
    }

    // Check for temporal chain: request started right after another correlated request finished
    const recentCorrelated = allRequests
      .filter((r) => r.correlatedActionId && r.timing.endTime)
      .sort((a, b) => (b.timing.endTime || 0) - (a.timing.endTime || 0));

    for (const parent of recentCorrelated) {
      if (!parent.timing.endTime) continue;
      const gap = request.timing.startTime - parent.timing.endTime;
      if (gap >= 0 && gap <= 100) {
        const action = this.actions.find(
          (a) => a.id === parent.correlatedActionId
        );
        if (action) {
          return { action, confidence: 0.5, method: "chain" };
        }
      }
    }

    return null;
  }

  // ── Chain Detection Within a Correlation Group ──

  detectChains(requests: CapturedRequest[]): RequestChain[] {
    const chains: RequestChain[] = [];

    // Detect redirect chains
    for (const req of requests) {
      if (req.redirectChain.length > 0) {
        chains.push({
          type: "redirect",
          requestIds: [req.id],
          description: `Redirect chain: ${req.redirectChain.map((r) => `${r.status} ${r.url}`).join(" → ")} → ${req.url}`,
        });
      }
    }

    // Detect preflight pairs
    for (const req of requests) {
      if (req.preflightRequestId) {
        const preflight = requests.find(
          (r) => r.id === req.preflightRequestId
        );
        if (preflight) {
          chains.push({
            type: "preflight",
            requestIds: [preflight.id, req.id],
            description: `CORS preflight: OPTIONS ${req.url} → ${req.method} ${req.url}`,
          });
        }
      }
    }

    // Detect auth flow chains
    const authChain = this.detectAuthFlow(requests);
    if (authChain) {
      chains.push(authChain);
    }

    // Detect sequential chains (request B fires right after A completes)
    const sequentialChains = this.detectSequentialChains(requests);
    chains.push(...sequentialChains);

    return chains;
  }

  private detectAuthFlow(requests: CapturedRequest[]): RequestChain | null {
    // Find auth-like POST requests that return tokens
    const authRequests = requests.filter((r) => {
      if (r.method !== "POST") return false;
      return /auth|login|sign.?in|token|session|oauth/i.test(r.url);
    });

    for (const authReq of authRequests) {
      if (authReq.status < 200 || authReq.status >= 300) continue;
      if (!authReq.responseBody) continue;

      let tokenValue: string | null = null;
      try {
        const body = JSON.parse(authReq.responseBody);
        tokenValue =
          body.token ||
          body.access_token ||
          body.jwt ||
          body.data?.token ||
          body.data?.access_token;
      } catch {
        continue;
      }

      if (!tokenValue || typeof tokenValue !== "string") continue;

      // Find subsequent requests using this token
      const tokenPrefix = tokenValue.substring(0, 20);
      const authenticated = requests.filter((r) => {
        if (r.timing.startTime <= authReq.timing.startTime) return false;
        const authHeader =
          r.requestHeaders["Authorization"] ||
          r.requestHeaders["authorization"];
        return authHeader && authHeader.includes(tokenPrefix);
      });

      if (authenticated.length > 0) {
        return {
          type: "auth_flow",
          requestIds: [authReq.id, ...authenticated.map((r) => r.id)],
          description: `Auth flow: POST ${authReq.url} → token → ${authenticated.length} authenticated request(s)`,
        };
      }
    }

    return null;
  }

  private detectSequentialChains(
    requests: CapturedRequest[]
  ): RequestChain[] {
    const chains: RequestChain[] = [];
    const sorted = [...requests].sort(
      (a, b) => a.timing.startTime - b.timing.startTime
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      if (!current.timing.endTime) continue;

      const gap = next.timing.startTime - current.timing.endTime;
      if (gap >= 0 && gap <= 50) {
        // Very tight timing suggests sequential dependency
        let currentPath: string;
        let nextPath: string;
        try {
          currentPath = new URL(current.url).pathname;
        } catch {
          currentPath = current.url;
        }
        try {
          nextPath = new URL(next.url).pathname;
        } catch {
          nextPath = next.url;
        }
        chains.push({
          type: "sequential",
          requestIds: [current.id, next.id],
          description: `Sequential: ${current.method} ${currentPath} → ${next.method} ${nextPath} (${gap.toFixed(0)}ms gap)`,
        });
      }
    }

    return chains;
  }

  // ── Helpers ──

  private isLikelyBackground(request: CapturedRequest): boolean {
    return BACKGROUND_PATTERNS.some((pattern) => pattern.test(request.url));
  }
}
