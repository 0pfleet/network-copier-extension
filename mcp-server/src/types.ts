/**
 * Core types for the Network Intelligence MCP Server.
 *
 * These types model captured network requests, user actions,
 * and the correlation between them.
 */

// ── Captured Network Request ──

export interface CapturedRequest {
  /** Unique identifier for this request (CDP requestId) */
  id: string;

  /** Monotonic index for display ordering */
  index: number;

  /** Request URL */
  url: string;

  /** HTTP method */
  method: string;

  /** Request headers */
  requestHeaders: Record<string, string>;

  /** Request body (POST data, etc.) */
  requestBody?: string;

  /** Response HTTP status code */
  status: number;

  /** Response status text */
  statusText: string;

  /** Response headers */
  responseHeaders: Record<string, string>;

  /** Response body (fetched after loadingFinished) */
  responseBody?: string;

  /** MIME type of the response */
  mimeType: string;

  /** Response body size in bytes */
  responseSize: number;

  /** Resource type classification */
  resourceType: ResourceType;

  /** CDP initiator data for correlation */
  initiator: RequestInitiator;

  /** Timing information */
  timing: RequestTiming;

  /** If this request was a redirect, the chain */
  redirectChain: RedirectEntry[];

  /** If this was a CORS preflight, links to the actual request */
  preflightFor?: string;

  /** If this had a preflight, links to it */
  preflightRequestId?: string;

  /** Correlated action ID (set by correlator) */
  correlatedActionId?: string;

  /** Correlation confidence (0-1) */
  correlationConfidence?: number;

  /** Correlation method used */
  correlationMethod?: "stack_trace" | "timing_semantic" | "timing_only" | "chain";
}

export type ResourceType =
  | "xhr"
  | "fetch"
  | "document"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "websocket"
  | "other";

export interface RequestInitiator {
  /** What caused the request */
  type: "parser" | "script" | "preload" | "preflight" | "other";

  /** JavaScript call stack (present when type is "script") */
  stack?: StackTrace;

  /** URL of the document that initiated the request */
  url?: string;

  /** Line number in the initiating document */
  lineNumber?: number;

  /** Column number in the initiating document */
  columnNumber?: number;

  /** For preflights: the requestId of the actual request */
  requestId?: string;
}

export interface StackTrace {
  /** Description of the async operation (e.g., "click", "setTimeout") */
  description?: string;

  /** Synchronous call frames */
  callFrames: CallFrame[];

  /** Async parent stack trace */
  parent?: StackTrace;
}

export interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface RequestTiming {
  /** Wall clock time when request started (ms since epoch) */
  startTime: number;

  /** Wall clock time when response was received (ms since epoch) */
  responseTime?: number;

  /** Wall clock time when loading finished (ms since epoch) */
  endTime?: number;

  /** Total duration in ms */
  duration?: number;
}

export interface RedirectEntry {
  url: string;
  status: number;
  headers: Record<string, string>;
}

// ── Tracked User Action ──

export interface TrackedAction {
  /** Unique identifier */
  id: string;

  /** Action type */
  type: ActionType;

  /** CSS selector of the target element */
  selector: string;

  /** Human-readable description of the target */
  targetDescription: string;

  /** Timestamp (ms since epoch) */
  timestamp: number;

  /** Page URL when action occurred */
  pageUrl: string;

  /** Request IDs correlated to this action */
  resultingRequestIds: string[];
}

export type ActionType =
  | "click"
  | "navigate"
  | "type"
  | "submit"
  | "scroll"
  | "agent_action";

// ── Correlation Result ──

export interface CorrelationResult {
  /** The action that triggered the requests */
  action: TrackedAction;

  /** Requests triggered by this action, ordered by start time */
  requests: CapturedRequest[];

  /** Request chains detected within this correlation */
  chains: RequestChain[];

  /** Overall confidence of the correlation */
  confidence: number;
}

export interface RequestChain {
  /** Type of chain relationship */
  type: "redirect" | "preflight" | "auth_flow" | "sequential";

  /** Ordered request IDs in the chain */
  requestIds: string[];

  /** Human-readable description of the chain */
  description: string;
}

// ── Network Capture Store ──

export interface NetworkFilter {
  /** Filter by URL pattern (regex) */
  urlPattern?: string;

  /** Filter by HTTP method */
  method?: string;

  /** Filter by status code range */
  statusMin?: number;
  statusMax?: number;

  /** Filter by resource type */
  resourceType?: ResourceType;

  /** Only requests after this action ID */
  sinceActionId?: string;

  /** Only requests after this timestamp */
  sinceTimestamp?: number;

  /** Maximum number of results */
  limit?: number;
}

// ── CDP Event Types (subset we care about) ──

export interface CDPRequestWillBeSent {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  timestamp: number;
  wallTime: number;
  initiator: {
    type: string;
    stack?: CDPStackTrace;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    requestId?: string;
  };
  redirectResponse?: {
    status: number;
    headers: Record<string, string>;
    statusText: string;
  };
  type?: string;
}

export interface CDPResponseReceived {
  requestId: string;
  response: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
  };
  timestamp: number;
  type?: string;
}

export interface CDPLoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}

export interface CDPStackTrace {
  description?: string;
  callFrames: Array<{
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  }>;
  parent?: CDPStackTrace;
}
