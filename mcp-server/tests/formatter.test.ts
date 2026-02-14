import { describe, it, expect } from "vitest";
import {
  formatCorrelation,
  formatRequest,
  formatRequestList,
  formatRequestDetail,
  formatBytes,
  maybePrettyJson,
} from "../src/formatter.js";
import type {
  CapturedRequest,
  CorrelationResult,
  TrackedAction,
} from "../src/types.js";

function makeRequest(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: "req_1",
    index: 0,
    url: "https://api.example.com/data",
    method: "GET",
    requestHeaders: { Accept: "application/json" },
    status: 200,
    statusText: "OK",
    responseHeaders: { "Content-Type": "application/json" },
    mimeType: "application/json",
    responseSize: 1024,
    resourceType: "fetch",
    initiator: { type: "script" },
    timing: {
      startTime: 1705312245123,
      responseTime: 1705312245212,
      endTime: 1705312245220,
      duration: 97,
    },
    redirectChain: [],
    ...overrides,
  };
}

function makeAction(overrides: Partial<TrackedAction> = {}): TrackedAction {
  return {
    id: "action_1",
    type: "click",
    selector: "#login-btn",
    targetDescription: 'button "Sign In"',
    timestamp: 1705312245100,
    pageUrl: "https://app.example.com/login",
    resultingRequestIds: ["req_1"],
    ...overrides,
  };
}

describe("Formatter", () => {
  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(500)).toBe("500 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1048576)).toBe("1.0 MB");
      expect(formatBytes(1572864)).toBe("1.5 MB");
    });

    it("should handle negative/undefined", () => {
      expect(formatBytes(-1)).toBe("0 B");
    });
  });

  describe("maybePrettyJson", () => {
    it("should pretty-print valid JSON", () => {
      const result = maybePrettyJson('{"key":"value"}');
      expect(result).toContain('"key": "value"');
      expect(result).toContain("\n");
    });

    it("should return non-JSON text as-is", () => {
      expect(maybePrettyJson("not json")).toBe("not json");
      expect(maybePrettyJson("<html>")).toBe("<html>");
    });
  });

  describe("formatRequest", () => {
    it("should format a basic request", () => {
      const output = formatRequest(makeRequest(), 1);
      expect(output).toContain("[1]");
      expect(output).toContain("GET");
      expect(output).toContain("https://api.example.com/data");
      expect(output).toContain("200 OK");
      expect(output).toContain("97ms");
    });

    it("should include request body when present", () => {
      const output = formatRequest(
        makeRequest({
          method: "POST",
          requestBody: JSON.stringify({ email: "test@test.com" }),
        }),
        1,
        { includeRequestBody: true }
      );
      expect(output).toContain("Request Body:");
      expect(output).toContain("test@test.com");
    });

    it("should include response body when present", () => {
      const output = formatRequest(
        makeRequest({
          responseBody: JSON.stringify({ users: [1, 2, 3] }),
        }),
        1,
        { includeResponseBody: true }
      );
      expect(output).toContain("Response Body:");
      expect(output).toContain("users");
    });

    it("should include headers when requested", () => {
      const output = formatRequest(makeRequest(), 1, {
        includeRequestHeaders: true,
        includeResponseHeaders: true,
      });
      expect(output).toContain("Request Headers:");
      expect(output).toContain("Accept: application/json");
      expect(output).toContain("Response Headers:");
      expect(output).toContain("Content-Type: application/json");
    });

    it("should show redirect info", () => {
      const output = formatRequest(
        makeRequest({
          redirectChain: [
            { url: "https://old.com", status: 301, headers: {} },
          ],
        }),
        1
      );
      expect(output).toContain("Redirects:");
      expect(output).toContain("301");
    });

    it("should show error status indicator for 4xx/5xx", () => {
      const output = formatRequest(
        makeRequest({
          status: 500,
          statusText: "Internal Server Error",
        }),
        1
      );
      expect(output).toContain("!");
      expect(output).toContain("500");
    });

    it("should redact sensitive headers", () => {
      const output = formatRequest(
        makeRequest({
          requestHeaders: {
            Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
            Cookie: "session=abc123def456ghi789",
          },
        }),
        1,
        { includeRequestHeaders: true }
      );
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("payload.signature");
    });

    it("should redact sensitive body fields", () => {
      const output = formatRequest(
        makeRequest({
          requestBody: JSON.stringify({
            email: "test@test.com",
            password: "secret123",
          }),
        }),
        1,
        { includeRequestBody: true }
      );
      expect(output).toContain("test@test.com");
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("secret123");
    });

    it("should redact nested sensitive fields in request bodies", () => {
      const output = formatRequest(
        makeRequest({
          requestBody: JSON.stringify({
            user: {
              email: "test@test.com",
              password: "nested_secret",
              profile: {
                ssn: "123-45-6789",
              },
            },
          }),
        }),
        1,
        { includeRequestBody: true }
      );
      expect(output).toContain("test@test.com");
      expect(output).not.toContain("nested_secret");
      expect(output).not.toContain("123-45-6789");
      // Both should be redacted
      expect(output).toContain("[REDACTED]");
    });

    it("should redact form-urlencoded passwords", () => {
      const output = formatRequest(
        makeRequest({
          requestBody: "email=test@test.com&password=secret123&remember=true",
        }),
        1,
        { includeRequestBody: true }
      );
      expect(output).toContain("test@test.com");
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("secret123");
      expect(output).toContain("remember=true");
    });

    it("should redact sensitive fields in response bodies", () => {
      const output = formatRequest(
        makeRequest({
          responseBody: JSON.stringify({
            access_token: "eyJhbGciOiJIUzI1NiJ9.test.sig",
            user: { id: 42, secret: "confidential_value" },
          }),
        }),
        1,
        { includeResponseBody: true }
      );
      expect(output).toContain("Response Body:");
      expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9.test.sig");
      expect(output).not.toContain("confidential_value");
      expect(output).toContain("[REDACTED]");
      expect(output).toContain('"id": 42');
    });
  });

  describe("formatCorrelation", () => {
    it("should format a full correlation result", () => {
      const result: CorrelationResult = {
        action: makeAction(),
        requests: [
          makeRequest({
            method: "POST",
            url: "https://api.example.com/auth/login",
          }),
        ],
        chains: [],
        confidence: 0.92,
      };

      const output = formatCorrelation(result);
      expect(output).toContain("ACTION:");
      expect(output).toContain('button "Sign In"');
      expect(output).toContain("#login-btn");
      expect(output).toContain("TRIGGERED REQUESTS (1):");
      expect(output).toContain("POST");
      expect(output).toContain("/auth/login");
    });

    it("should show chain info", () => {
      const result: CorrelationResult = {
        action: makeAction(),
        requests: [makeRequest()],
        chains: [
          {
            type: "auth_flow",
            requestIds: ["req_1", "req_2"],
            description: "Auth flow: POST /auth → 2 authenticated requests",
          },
        ],
        confidence: 0.85,
      };

      const output = formatCorrelation(result);
      expect(output).toContain("REQUEST CHAINS:");
      expect(output).toContain("AUTH_FLOW");
    });

    it("should handle empty requests", () => {
      const result: CorrelationResult = {
        action: makeAction(),
        requests: [],
        chains: [],
        confidence: 0,
      };

      const output = formatCorrelation(result);
      expect(output).toContain("No network requests triggered");
    });

    it("should optionally show confidence", () => {
      const result: CorrelationResult = {
        action: makeAction(),
        requests: [makeRequest()],
        chains: [],
        confidence: 0.92,
      };

      const withConfidence = formatCorrelation(result, {
        showConfidence: true,
      });
      expect(withConfidence).toContain("0.92");

      const withoutConfidence = formatCorrelation(result, {
        showConfidence: false,
      });
      expect(withoutConfidence).not.toContain("0.92");
    });
  });

  describe("formatRequestList", () => {
    it("should format a list of requests with header", () => {
      const requests = [
        makeRequest({ id: "req_1", index: 0 }),
        makeRequest({
          id: "req_2",
          index: 1,
          url: "https://api.example.com/users",
          method: "POST",
          status: 201,
          statusText: "Created",
        }),
      ];

      const output = formatRequestList(requests);
      expect(output).toContain("2 request(s)");
      expect(output).toContain("[1]");
      expect(output).toContain("[2]");
    });

    it("should handle empty list", () => {
      const output = formatRequestList([]);
      expect(output).toContain("No requests captured");
    });
  });

  describe("formatRequestDetail", () => {
    it("should format full request detail", () => {
      const request = makeRequest({
        responseBody: JSON.stringify({ data: "test" }),
        requestBody: JSON.stringify({ query: "SELECT 1" }),
      });

      const output = formatRequestDetail(request);
      expect(output).toContain("REQUEST DETAIL:");
      expect(output).toContain("URL:");
      expect(output).toContain("Method: GET");
      expect(output).toContain("TIMING:");
      expect(output).toContain("INITIATOR:");
      expect(output).toContain("REQUEST HEADERS:");
      expect(output).toContain("RESPONSE HEADERS:");
      expect(output).toContain("REQUEST BODY:");
      expect(output).toContain("RESPONSE BODY:");
    });

    it("should include correlation data when present", () => {
      const request = makeRequest({
        correlatedActionId: "action_1",
        correlationConfidence: 0.95,
        correlationMethod: "stack_trace",
      });

      const output = formatRequestDetail(request);
      expect(output).toContain("CORRELATION:");
      expect(output).toContain("action_1");
      expect(output).toContain("0.95");
      expect(output).toContain("stack_trace");
    });

    it("should redact sensitive fields in response bodies", () => {
      const request = makeRequest({
        responseBody: JSON.stringify({
          token: "super_secret_token_value",
          user: { id: 42, name: "Oscar" },
        }),
      });

      const output = formatRequestDetail(request);
      expect(output).toContain("RESPONSE BODY:");
      expect(output).not.toContain("super_secret_token_value");
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("Oscar");
    });

    it("should include stack trace when present", () => {
      const request = makeRequest({
        initiator: {
          type: "script",
          stack: {
            callFrames: [
              {
                functionName: "fetchData",
                scriptId: "1",
                url: "https://app.example.com/app.js",
                lineNumber: 41,
                columnNumber: 9,
              },
            ],
            parent: {
              description: "click",
              callFrames: [
                {
                  functionName: "onClick",
                  scriptId: "1",
                  url: "https://app.example.com/app.js",
                  lineNumber: 30,
                  columnNumber: 4,
                },
              ],
            },
          },
        },
      });

      const output = formatRequestDetail(request);
      expect(output).toContain("Stack:");
      expect(output).toContain("fetchData");
      expect(output).toContain("app.js:42:10"); // lineNumber+1, columnNumber+1
      expect(output).toContain("--- click ---");
    });
  });
});
