import { describe, it, expect, beforeEach } from "vitest";
import { Correlator } from "../src/correlator.js";
import { NetworkCapture } from "../src/network.js";
import type { CapturedRequest, TrackedAction } from "../src/types.js";
import {
  loginPostRequest,
  simpleGetRequest,
  corsPreflightPair,
  resetTimestamps,
} from "./fixtures/cdp-events.js";

describe("Correlator", () => {
  let correlator: Correlator;
  let capture: NetworkCapture;

  beforeEach(() => {
    correlator = new Correlator();
    capture = new NetworkCapture();
    resetTimestamps();
  });

  // Helper: process a CDP event set through capture and return the request
  async function processRequest(events: {
    willBeSent: any;
    responseReceived: any;
    loadingFinished: any;
    responseBody?: string;
  }): Promise<CapturedRequest> {
    capture.handleRequestWillBeSent(events.willBeSent);
    capture.handleResponseReceived(events.responseReceived);

    if (events.responseBody) {
      capture.handleLoadingFinished(events.loadingFinished, async () => ({
        body: events.responseBody!,
        base64Encoded: false,
      }));
      // Wait for async body fetch to complete
      await new Promise((r) => setTimeout(r, 20));
    } else {
      capture.handleLoadingFinished(events.loadingFinished);
    }

    return capture.getRequest(events.willBeSent.requestId)!;
  }

  function createAction(
    overrides: Partial<TrackedAction> = {}
  ): TrackedAction {
    return {
      id: "action_1",
      type: "click",
      selector: "#login-btn",
      targetDescription: 'button "Sign In"',
      timestamp: Date.now(),
      pageUrl: "https://app.example.com/login",
      resultingRequestIds: [],
      ...overrides,
    };
  }

  describe("action recording", () => {
    it("should record and retrieve actions", () => {
      const action = createAction();
      correlator.recordAction(action);

      expect(correlator.getActions()).toHaveLength(1);
      expect(correlator.getAction("action_1")).toBeDefined();
    });

    it("should clear actions", () => {
      correlator.recordAction(createAction());
      correlator.clear();
      expect(correlator.getActions()).toHaveLength(0);
    });
  });

  describe("stack trace correlation (Layer 1)", () => {
    it("should extract click event from async stack trace", async () => {
      const loginReq = loginPostRequest();
      const request = await processRequest(loginReq);

      // The login request's stack trace has a "click" in its parent chain
      const result = correlator.extractEventOrigin(request.initiator.stack!);
      expect(result).not.toBeNull();
      expect(result!.eventType).toBe("click");
      expect(result!.asyncDepth).toBe(2); // stack -> await -> click
    });

    it("should correlate request with matching action via stack trace", async () => {
      const loginReq = loginPostRequest();
      const request = await processRequest(loginReq);

      // Create action at roughly the same time as the request
      const action = createAction({
        timestamp: request.timing.startTime - 50, // 50ms before request
        type: "click",
      });
      correlator.recordAction(action);

      const match = correlator.correlateRequest(
        request,
        capture.getRequests()
      );

      expect(match).not.toBeNull();
      expect(match!.action.id).toBe("action_1");
      expect(match!.method).toBe("stack_trace");
      expect(match!.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("should return null for requests without stack traces", async () => {
      const getReq = simpleGetRequest();
      const request = await processRequest(getReq);

      // No action recorded, and no stack trace
      const result = correlator.extractEventOrigin(
        request.initiator.stack || { callFrames: [] }
      );
      expect(result).toBeNull();
    });
  });

  describe("timing + semantic correlation (Layer 2)", () => {
    it("should correlate click action with POST request by timing and semantics", async () => {
      const loginReq = loginPostRequest();

      // Record action BEFORE processing the request
      const actionTimestamp =
        loginReq.willBeSent.wallTime * 1000 - 30; // 30ms before request

      const action = createAction({
        id: "action_login",
        type: "click",
        selector: "#login-btn",
        targetDescription: 'button "Login"',
        timestamp: actionTimestamp,
      });
      correlator.recordAction(action);

      // Process request without stack trace for this test
      const noStackReq = {
        ...loginReq,
        willBeSent: {
          ...loginReq.willBeSent,
          initiator: { type: "script" as const }, // No stack trace
        },
      };

      const request = await processRequest(noStackReq);

      const match = correlator.correlateRequest(
        request,
        capture.getRequests()
      );

      expect(match).not.toBeNull();
      expect(match!.action.id).toBe("action_login");
      expect(match!.method).toBe("timing_semantic");
      // "Login" button + POST /auth/login should score well
      expect(match!.confidence).toBeGreaterThan(0.3);
    });

    it("should prefer closer actions when multiple candidates exist", async () => {
      const loginReq = loginPostRequest();
      const requestTime = loginReq.willBeSent.wallTime * 1000;

      // Two actions: one far, one close
      correlator.recordAction(
        createAction({
          id: "action_far",
          timestamp: requestTime - 1500,
          targetDescription: 'button "Something"',
        })
      );
      correlator.recordAction(
        createAction({
          id: "action_close",
          timestamp: requestTime - 20,
          targetDescription: 'button "Login"',
        })
      );

      const noStackReq = {
        ...loginReq,
        willBeSent: {
          ...loginReq.willBeSent,
          initiator: { type: "script" as const },
        },
      };
      const request = await processRequest(noStackReq);

      const match = correlator.correlateRequest(
        request,
        capture.getRequests()
      );

      expect(match).not.toBeNull();
      expect(match!.action.id).toBe("action_close");
    });

    it("should penalize background/analytics requests", () => {
      const action = createAction({
        timestamp: Date.now(),
      });
      correlator.recordAction(action);

      // Create a request that looks like analytics
      const analyticsRequest: CapturedRequest = {
        id: "req_analytics",
        index: 0,
        url: "https://www.google-analytics.com/collect",
        method: "POST",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "text/plain",
        responseSize: 0,
        resourceType: "xhr",
        initiator: { type: "script" },
        timing: { startTime: action.timestamp + 10 },
        redirectChain: [],
      };

      const match = correlator.correlateRequest(analyticsRequest, [
        analyticsRequest,
      ]);

      // Should either not match or have very low confidence
      if (match) {
        expect(match.confidence).toBeLessThan(0.3);
      }
    });
  });

  describe("semantic scoring patterns", () => {
    const testSemantic = (
      actionDesc: string,
      actionType: TrackedAction["type"],
      requestUrl: string,
      requestMethod: string,
      expectedMinScore: number
    ) => {
      const action = createAction({
        type: actionType,
        targetDescription: actionDesc,
        timestamp: Date.now(),
      });
      correlator.recordAction(action);

      const request: CapturedRequest = {
        id: "req_test",
        index: 0,
        url: requestUrl,
        method: requestMethod,
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "application/json",
        responseSize: 100,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: action.timestamp + 10 },
        redirectChain: [],
      };

      const match = correlator.correlateRequest(request, [request]);
      expect(match).not.toBeNull();
      expect(match!.confidence).toBeGreaterThanOrEqual(expectedMinScore);
    };

    it("should score login button + auth POST highly", () => {
      testSemantic(
        'button "Sign In"',
        "click",
        "https://api.example.com/auth/login",
        "POST",
        0.4
      );
    });

    it("should score search input + search GET highly", () => {
      testSemantic(
        'input "Search"',
        "click",
        "https://api.example.com/search?q=test",
        "GET",
        0.3
      );
    });

    it("should score delete button + DELETE request highly", () => {
      testSemantic(
        'button "Delete"',
        "click",
        "https://api.example.com/users/42",
        "DELETE",
        0.3
      );
    });

    it("should score navigate action + document request highly", () => {
      const action = createAction({
        type: "navigate",
        targetDescription: "https://example.com",
        timestamp: Date.now(),
      });
      correlator.recordAction(action);

      const request: CapturedRequest = {
        id: "req_doc",
        index: 0,
        url: "https://example.com",
        method: "GET",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "text/html",
        responseSize: 5000,
        resourceType: "document",
        initiator: { type: "other" },
        timing: { startTime: action.timestamp + 5 },
        redirectChain: [],
      };

      const match = correlator.correlateRequest(request, [request]);
      expect(match).not.toBeNull();
      expect(match!.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe("chain correlation (Layer 4)", () => {
    it("should correlate preflight request via chain membership", () => {
      const cors = corsPreflightPair();

      // Process preflight first (as it happens in real CDP)
      capture.handleRequestWillBeSent(cors.preflight.willBeSent);
      capture.handleResponseReceived(cors.preflight.responseReceived);
      capture.handleLoadingFinished(cors.preflight.loadingFinished);

      // Then actual request
      capture.handleRequestWillBeSent(cors.actual.willBeSent);
      capture.handleResponseReceived(cors.actual.responseReceived);
      capture.handleLoadingFinished(cors.actual.loadingFinished);

      const allRequests = capture.getRequests();
      const actual = allRequests.find((r) => r.id === "req_actual")!;

      // Manually correlate the actual request
      const action = createAction({
        timestamp: actual.timing.startTime - 20,
      });
      correlator.recordAction(action);

      // Correlate actual request first
      actual.correlatedActionId = action.id;

      // Now the preflight should be picked up via chain
      const preflight = allRequests.find((r) => r.id === "req_preflight")!;
      const match = correlator.correlateRequest(preflight, allRequests);

      expect(match).not.toBeNull();
      expect(match!.action.id).toBe(action.id);
      expect(match!.method).toBe("chain");
    });
  });

  describe("chain detection", () => {
    it("should detect redirect chains", () => {
      const request: CapturedRequest = {
        id: "req_1",
        index: 0,
        url: "https://example.com/final",
        method: "GET",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "text/html",
        responseSize: 5000,
        resourceType: "document",
        initiator: { type: "other" },
        timing: { startTime: Date.now() },
        redirectChain: [
          {
            url: "https://example.com/old",
            status: 301,
            headers: {},
          },
        ],
      };

      const chains = correlator.detectChains([request]);
      const redirectChains = chains.filter((c) => c.type === "redirect");
      expect(redirectChains).toHaveLength(1);
      expect(redirectChains[0].description).toContain("301");
    });

    it("should detect preflight pairs in chain detection", () => {
      const preflight: CapturedRequest = {
        id: "req_pre",
        index: 0,
        url: "https://api.example.com/data",
        method: "OPTIONS",
        requestHeaders: {},
        status: 204,
        statusText: "No Content",
        responseHeaders: {},
        mimeType: "",
        responseSize: 0,
        resourceType: "other",
        initiator: { type: "preflight", requestId: "req_main" },
        timing: { startTime: Date.now() },
        redirectChain: [],
        preflightFor: "req_main",
      };

      const actual: CapturedRequest = {
        id: "req_main",
        index: 1,
        url: "https://api.example.com/data",
        method: "POST",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "application/json",
        responseSize: 1024,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: Date.now() + 20 },
        redirectChain: [],
        preflightRequestId: "req_pre",
      };

      const chains = correlator.detectChains([preflight, actual]);
      const preflightChains = chains.filter((c) => c.type === "preflight");
      expect(preflightChains).toHaveLength(1);
      expect(preflightChains[0].requestIds).toContain("req_pre");
      expect(preflightChains[0].requestIds).toContain("req_main");
    });

    it("should detect auth flow chains", async () => {
      // Auth request
      const authRequest: CapturedRequest = {
        id: "req_auth",
        index: 0,
        url: "https://api.example.com/auth/login",
        method: "POST",
        requestHeaders: {},
        requestBody: JSON.stringify({ email: "test@test.com" }),
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        responseBody: JSON.stringify({
          access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
        }),
        mimeType: "application/json",
        responseSize: 256,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: Date.now() },
        redirectChain: [],
      };

      // Authenticated request using the token
      const authedRequest: CapturedRequest = {
        id: "req_profile",
        index: 1,
        url: "https://api.example.com/user/profile",
        method: "GET",
        requestHeaders: {
          Authorization:
            "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
        },
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "application/json",
        responseSize: 512,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: Date.now() + 100 },
        redirectChain: [],
      };

      const chains = correlator.detectChains([authRequest, authedRequest]);
      const authChains = chains.filter((c) => c.type === "auth_flow");
      expect(authChains).toHaveLength(1);
      expect(authChains[0].requestIds).toContain("req_auth");
      expect(authChains[0].requestIds).toContain("req_profile");
      expect(authChains[0].description).toContain("Auth flow");
    });

    it("should detect sequential chains by timing", () => {
      const now = Date.now();

      const first: CapturedRequest = {
        id: "req_1",
        index: 0,
        url: "https://api.example.com/step1",
        method: "GET",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "application/json",
        responseSize: 100,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: now, endTime: now + 100, duration: 100 },
        redirectChain: [],
      };

      const second: CapturedRequest = {
        id: "req_2",
        index: 1,
        url: "https://api.example.com/step2",
        method: "GET",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "application/json",
        responseSize: 100,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: now + 110, endTime: now + 200, duration: 90 },
        redirectChain: [],
      };

      const chains = correlator.detectChains([first, second]);
      const seqChains = chains.filter((c) => c.type === "sequential");
      expect(seqChains).toHaveLength(1);
      expect(seqChains[0].requestIds).toEqual(["req_1", "req_2"]);
    });

    it("should handle invalid/malformed URLs in sequential chain detection without crashing", () => {
      const now = Date.now();

      const requests: CapturedRequest[] = [
        {
          id: "req_data",
          index: 0,
          url: "data:text/html,<h1>Hello</h1>",
          method: "GET",
          requestHeaders: {},
          status: 200,
          statusText: "OK",
          responseHeaders: {},
          mimeType: "text/html",
          responseSize: 100,
          resourceType: "document",
          initiator: { type: "other" },
          timing: { startTime: now, endTime: now + 50, duration: 50 },
          redirectChain: [],
        },
        {
          id: "req_blob",
          index: 1,
          url: "blob:https://example.com/abc-123",
          method: "GET",
          requestHeaders: {},
          status: 200,
          statusText: "OK",
          responseHeaders: {},
          mimeType: "application/octet-stream",
          responseSize: 500,
          resourceType: "other",
          initiator: { type: "script" },
          timing: { startTime: now + 60, endTime: now + 100, duration: 40 },
          redirectChain: [],
        },
        {
          id: "req_empty",
          index: 2,
          url: "",
          method: "GET",
          requestHeaders: {},
          status: 0,
          statusText: "",
          responseHeaders: {},
          mimeType: "",
          responseSize: 0,
          resourceType: "other",
          initiator: { type: "other" },
          timing: { startTime: now + 110, endTime: now + 120, duration: 10 },
          redirectChain: [],
        },
      ];

      // Should not throw — previously would crash on `new URL("")`
      expect(() => correlator.detectChains(requests)).not.toThrow();

      const chains = correlator.detectChains(requests);
      const seqChains = chains.filter((c) => c.type === "sequential");
      // The data: and blob: URLs have tight timing, so they should be detected
      expect(seqChains.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("correlateAll", () => {
    it("should bulk correlate all uncorrelated requests to actions", () => {
      const now = Date.now();

      // Record two actions
      correlator.recordAction(
        createAction({
          id: "action_click",
          type: "click",
          targetDescription: 'button "Login"',
          timestamp: now,
        })
      );

      correlator.recordAction(
        createAction({
          id: "action_nav",
          type: "navigate",
          targetDescription: "https://example.com/dashboard",
          timestamp: now + 500,
        })
      );

      // Create requests for each
      const requests: CapturedRequest[] = [
        {
          id: "req_login",
          index: 0,
          url: "https://api.example.com/auth/login",
          method: "POST",
          requestHeaders: {},
          status: 200,
          statusText: "OK",
          responseHeaders: {},
          mimeType: "application/json",
          responseSize: 256,
          resourceType: "fetch",
          initiator: { type: "script" },
          timing: { startTime: now + 20 },
          redirectChain: [],
        },
        {
          id: "req_dashboard",
          index: 1,
          url: "https://example.com/dashboard",
          method: "GET",
          requestHeaders: {},
          status: 200,
          statusText: "OK",
          responseHeaders: {},
          mimeType: "text/html",
          responseSize: 5000,
          resourceType: "document",
          initiator: { type: "other" },
          timing: { startTime: now + 510 },
          redirectChain: [],
        },
      ];

      const results = correlator.correlateAll(requests);

      expect(results).toHaveLength(2);
      expect(results[0].action.id).toBe("action_click");
      expect(results[0].requests[0].id).toBe("req_login");
      expect(results[1].action.id).toBe("action_nav");
      expect(results[1].requests[0].id).toBe("req_dashboard");
    });
  });

  describe("edge cases", () => {
    it("should not correlate requests before any action", () => {
      const request: CapturedRequest = {
        id: "req_early",
        index: 0,
        url: "https://api.example.com/data",
        method: "GET",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "application/json",
        responseSize: 100,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: Date.now() },
        redirectChain: [],
      };

      const match = correlator.correlateRequest(request, [request]);
      expect(match).toBeNull();
    });

    it("should not correlate requests outside the time window", () => {
      const now = Date.now();

      correlator.recordAction(
        createAction({
          timestamp: now - 5000, // 5 seconds ago, outside 2s window
        })
      );

      const request: CapturedRequest = {
        id: "req_late",
        index: 0,
        url: "https://api.example.com/data",
        method: "GET",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {},
        mimeType: "application/json",
        responseSize: 100,
        resourceType: "fetch",
        initiator: { type: "script" },
        timing: { startTime: now },
        redirectChain: [],
      };

      const match = correlator.correlateRequest(request, [request]);
      expect(match).toBeNull();
    });
  });
});
