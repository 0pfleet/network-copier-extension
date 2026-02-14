/**
 * Agent-friendly output formatter.
 *
 * Converts structured capture data into clean, LLM-optimized text output.
 * Designed to be scannable, hierarchical, and information-dense without
 * being overwhelming.
 */

import type {
  CapturedRequest,
  CorrelationResult,
  RequestChain,
  StackTrace,
  TrackedAction,
} from "./types.js";

export interface FormatOptions {
  /** Include request headers */
  includeRequestHeaders?: boolean;

  /** Include response headers */
  includeResponseHeaders?: boolean;

  /** Include request body */
  includeRequestBody?: boolean;

  /** Include response body */
  includeResponseBody?: boolean;

  /** Maximum body length before truncation */
  maxBodyLength?: number;

  /** Show timing information */
  showTiming?: boolean;

  /** Show correlation confidence */
  showConfidence?: boolean;
}

const DEFAULT_FORMAT_OPTIONS: Required<FormatOptions> = {
  includeRequestHeaders: false,
  includeResponseHeaders: false,
  includeRequestBody: true,
  includeResponseBody: true,
  maxBodyLength: 5000,
  showTiming: true,
  showConfidence: false,
};

/**
 * Format a correlation result (action + its triggered requests).
 */
export function formatCorrelation(
  result: CorrelationResult,
  options?: FormatOptions
): string {
  const opts = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push("════════════════════════════════════════════════════════════");
  lines.push(`ACTION: ${formatActionDescription(result.action)}`);
  lines.push(`TIME: ${new Date(result.action.timestamp).toISOString()}`);
  if (opts.showConfidence) {
    lines.push(
      `CORRELATION: ${result.confidence.toFixed(2)} confidence`
    );
  }
  lines.push("════════════════════════════════════════════════════════════");
  lines.push("");

  if (result.requests.length === 0) {
    lines.push("No network requests triggered by this action.");
    return lines.join("\n");
  }

  lines.push(`TRIGGERED REQUESTS (${result.requests.length}):`);
  lines.push("");

  for (let i = 0; i < result.requests.length; i++) {
    lines.push(formatRequest(result.requests[i], i + 1, opts));
    lines.push("");
  }

  // Chains
  if (result.chains.length > 0) {
    lines.push("REQUEST CHAINS:");
    for (const chain of result.chains) {
      lines.push(`  ${chain.type.toUpperCase()}: ${chain.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format a single request in detail.
 */
export function formatRequest(
  request: CapturedRequest,
  index: number,
  options?: FormatOptions
): string {
  const opts = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  const lines: string[] = [];

  const duration = request.timing.duration
    ? `${Math.round(request.timing.duration)}ms`
    : "pending";

  const statusEmoji = request.status >= 400 ? "!" : "";

  lines.push(
    `[${index}] ${statusEmoji}${request.method} ${request.url}`
  );
  lines.push(
    `    Status: ${request.status} ${request.statusText} (${duration})`
  );

  if (request.redirectChain.length > 0) {
    lines.push(
      `    Redirects: ${request.redirectChain.map((r) => `${r.status}`).join(" → ")} → ${request.status}`
    );
  }

  if (request.preflightRequestId) {
    lines.push(`    Has CORS preflight`);
  }

  if (opts.includeRequestHeaders) {
    lines.push("");
    lines.push("    Request Headers:");
    for (const [name, value] of Object.entries(request.requestHeaders)) {
      lines.push(`      ${name}: ${redactSensitiveHeader(name, value)}`);
    }
  }

  if (opts.includeResponseHeaders) {
    lines.push("");
    lines.push("    Response Headers:");
    for (const [name, value] of Object.entries(request.responseHeaders)) {
      lines.push(`      ${name}: ${value}`);
    }
  }

  if (opts.includeRequestBody && request.requestBody) {
    lines.push("");
    lines.push("    Request Body:");
    lines.push(
      indentBody(
        maybePrettyJson(
          maybeRedactBody(truncate(request.requestBody, opts.maxBodyLength))
        ),
        6
      )
    );
  }

  if (opts.includeResponseBody && request.responseBody) {
    lines.push("");
    lines.push("    Response Body:");
    lines.push(
      indentBody(
        maybePrettyJson(truncate(request.responseBody, opts.maxBodyLength)),
        6
      )
    );
  }

  return lines.join("\n");
}

/**
 * Format a list of requests as a summary table.
 */
export function formatRequestList(
  requests: CapturedRequest[],
  options?: FormatOptions
): string {
  const opts = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push(
    `Network Capture — ${requests.length} request(s) — ${new Date().toISOString()}`
  );
  lines.push("");

  if (requests.length === 0) {
    lines.push("No requests captured.");
    return lines.join("\n");
  }

  // Summary table
  lines.push("REQUESTS:");
  lines.push("");

  for (let i = 0; i < requests.length; i++) {
    lines.push(formatRequest(requests[i], i + 1, opts));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format a single request in full detail (for get_request_detail tool).
 */
export function formatRequestDetail(request: CapturedRequest): string {
  const lines: string[] = [];

  lines.push("════════════════════════════════════════════════════════════");
  lines.push(`REQUEST DETAIL: ${request.method} ${request.url}`);
  lines.push("════════════════════════════════════════════════════════════");
  lines.push("");

  // Basic info
  lines.push(`URL: ${request.url}`);
  lines.push(`Method: ${request.method}`);
  lines.push(`Status: ${request.status} ${request.statusText}`);
  lines.push(`Type: ${request.resourceType}`);
  lines.push(`Size: ${formatBytes(request.responseSize)}`);
  lines.push(`MIME: ${request.mimeType}`);
  lines.push("");

  // Timing
  lines.push("TIMING:");
  lines.push(
    `  Started: ${new Date(request.timing.startTime).toISOString()}`
  );
  if (request.timing.responseTime) {
    lines.push(
      `  TTFB: ${Math.round(request.timing.responseTime - request.timing.startTime)}ms`
    );
  }
  if (request.timing.duration) {
    lines.push(`  Total: ${Math.round(request.timing.duration)}ms`);
  }
  lines.push("");

  // Initiator
  lines.push("INITIATOR:");
  lines.push(`  Type: ${request.initiator.type}`);
  if (request.initiator.url) {
    lines.push(`  URL: ${request.initiator.url}`);
  }
  if (request.initiator.stack) {
    lines.push("  Stack:");
    lines.push(formatStackTrace(request.initiator.stack, 4));
  }
  lines.push("");

  // Correlation
  if (request.correlatedActionId) {
    lines.push("CORRELATION:");
    lines.push(`  Action: ${request.correlatedActionId}`);
    lines.push(`  Confidence: ${(request.correlationConfidence || 0).toFixed(2)}`);
    lines.push(`  Method: ${request.correlationMethod}`);
    lines.push("");
  }

  // Redirect chain
  if (request.redirectChain.length > 0) {
    lines.push("REDIRECT CHAIN:");
    for (const redirect of request.redirectChain) {
      lines.push(`  ${redirect.status} ${redirect.url}`);
    }
    lines.push(`  → ${request.status} ${request.url} (final)`);
    lines.push("");
  }

  // Headers
  lines.push("REQUEST HEADERS:");
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    lines.push(`  ${name}: ${redactSensitiveHeader(name, value)}`);
  }
  lines.push("");

  lines.push("RESPONSE HEADERS:");
  for (const [name, value] of Object.entries(request.responseHeaders)) {
    lines.push(`  ${name}: ${value}`);
  }
  lines.push("");

  // Bodies
  if (request.requestBody) {
    lines.push("REQUEST BODY:");
    lines.push(indentBody(maybePrettyJson(maybeRedactBody(request.requestBody)), 2));
    lines.push("");
  }

  if (request.responseBody) {
    lines.push("RESPONSE BODY:");
    lines.push(indentBody(maybePrettyJson(request.responseBody), 2));
    lines.push("");
  }

  return lines.join("\n");
}

// ── Helpers ──

function formatActionDescription(action: TrackedAction): string {
  const typeLabel = action.type.charAt(0).toUpperCase() + action.type.slice(1);
  return `${typeLabel} on ${action.targetDescription} (${action.selector})`;
}

function formatStackTrace(stack: StackTrace, indent: number): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];

  for (const frame of stack.callFrames) {
    const name = frame.functionName || "(anonymous)";
    // Filter out framework internals for cleaner output
    if (isFrameworkInternal(frame.url)) continue;
    lines.push(
      `${pad}at ${name} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`
    );
  }

  if (stack.parent) {
    const desc = stack.parent.description || "async";
    lines.push(`${pad}--- ${desc} ---`);
    lines.push(formatStackTrace(stack.parent, indent));
  }

  return lines.join("\n");
}

function isFrameworkInternal(url: string): boolean {
  return (
    url.includes("node_modules") ||
    url.includes("react-dom") ||
    url.includes("scheduler") ||
    url.includes("chunk-") ||
    url.includes("vendor-")
  );
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return (
    text.substring(0, maxLength) +
    `\n... [truncated, ${text.length} total chars]`
  );
}

function indentBody(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

export function maybePrettyJson(text: string): string {
  try {
    const obj = JSON.parse(text);
    return JSON.stringify(obj, null, 2);
  } catch {
    return text;
  }
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "x-xsrf-token",
]);

function redactSensitiveHeader(name: string, value: string): string {
  if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
    if (value.length <= 20) return "[REDACTED]";
    return value.substring(0, 15) + "...[REDACTED]";
  }
  return value;
}

const SENSITIVE_BODY_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "csrf",
  "ssn",
  "credit_card",
  "card_number",
  "cvv",
  "cvc",
  "pin",
  "otp",
]);

function maybeRedactBody(text: string): string {
  try {
    const obj = JSON.parse(text);
    const redacted = redactObject(obj);
    return JSON.stringify(redacted);
  } catch {
    return text;
  }
}

function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactObject);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_BODY_KEYS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
