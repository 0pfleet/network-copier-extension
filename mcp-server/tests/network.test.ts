import { describe, it, expect, beforeEach } from "vitest";
import { NetworkCapture } from "../src/network.js";
import {
  simpleGetRequest,
  loginPostRequest,
  redirectChain,
  corsPreflightPair,
  failedRequest,
  imageRequest,
  backgroundRequests,
  resetTimestamps,
} from "./fixtures/cdp-events.js";

describe("NetworkCapture", () => {
  let capture: NetworkCapture;

  beforeEach(() => {
    capture = new NetworkCapture();
    resetTimestamps();
  });

  describe("basic request lifecycle", () => {
    it("should capture a simple GET request through the full lifecycle", () => {
      const req = simpleGetRequest();

      capture.handleRequestWillBeSent(req.willBeSent);
      expect(capture.pendingCount).toBe(1);
      expect(capture.size).toBe(0);

      capture.handleResponseReceived(req.responseReceived);
      expect(capture.pendingCount).toBe(1); // still pending until loadingFinished

      capture.handleLoadingFinished(req.loadingFinished);
      expect(capture.pendingCount).toBe(0);
      expect(capture.size).toBe(1);

      const result = capture.getRequest("req_1");
      expect(result).toBeDefined();
      expect(result!.url).toBe("https://api.example.com/users");
      expect(result!.method).toBe("GET");
      expect(result!.status).toBe(200);
      expect(result!.statusText).toBe("OK");
      expect(result!.resourceType).toBe("fetch");
    });

    it("should capture a POST request with body", () => {
      const req = loginPostRequest();

      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleResponseReceived(req.responseReceived);
      capture.handleLoadingFinished(req.loadingFinished);

      const result = capture.getRequest("req_login");
      expect(result).toBeDefined();
      expect(result!.method).toBe("POST");
      expect(result!.requestBody).toContain("user@example.com");
      expect(result!.status).toBe(200);
    });

    it("should capture request with initiator stack trace", () => {
      const req = loginPostRequest();

      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleResponseReceived(req.responseReceived);
      capture.handleLoadingFinished(req.loadingFinished);

      const result = capture.getRequest("req_login");
      expect(result!.initiator.type).toBe("script");
      expect(result!.initiator.stack).toBeDefined();
      expect(result!.initiator.stack!.callFrames.length).toBeGreaterThan(0);

      // Should have async parent chain going back to "click"
      const parent = result!.initiator.stack!.parent;
      expect(parent).toBeDefined();
      expect(parent!.description).toBe("await");

      const grandparent = parent!.parent;
      expect(grandparent).toBeDefined();
      expect(grandparent!.description).toBe("click");
    });

    it("should handle a failed request", () => {
      const req = failedRequest();

      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleResponseReceived(req.responseReceived);
      capture.handleLoadingFinished(req.loadingFinished);

      const result = capture.getRequest("req_error");
      expect(result).toBeDefined();
      expect(result!.status).toBe(500);
      expect(result!.statusText).toBe("Internal Server Error");
    });

    it("should handle loadingFailed events", () => {
      const req = simpleGetRequest();

      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleLoadingFailed({
        requestId: "req_1",
        errorText: "net::ERR_CONNECTION_REFUSED",
        timestamp: req.willBeSent.timestamp + 0.5,
      });

      expect(capture.size).toBe(1);
      const result = capture.getRequest("req_1");
      expect(result!.status).toBe(0);
      expect(result!.statusText).toBe("net::ERR_CONNECTION_REFUSED");
    });
  });

  describe("redirect chains", () => {
    it("should track redirect chain through multiple hops", () => {
      const { events } = redirectChain();

      for (const event of events) {
        if (event.type === "willBeSent") {
          capture.handleRequestWillBeSent(event.data as any);
        } else if (event.type === "responseReceived") {
          capture.handleResponseReceived(event.data as any);
        } else if (event.type === "loadingFinished") {
          capture.handleLoadingFinished(event.data as any);
        }
      }

      expect(capture.size).toBe(1); // Single request with redirect chain
      const result = capture.getRequest("req_redirect");
      expect(result).toBeDefined();
      expect(result!.url).toBe("https://example.com/final-page");
      expect(result!.redirectChain).toHaveLength(2);
      expect(result!.redirectChain[0].status).toBe(301);
      expect(result!.redirectChain[0].url).toBe("https://example.com/old-page");
      expect(result!.redirectChain[1].status).toBe(302);
      expect(result!.redirectChain[1].url).toBe("https://example.com/new-page");
    });
  });

  describe("CORS preflight pairing", () => {
    it("should pair preflight with actual request", () => {
      const cors = corsPreflightPair();

      // Process preflight
      capture.handleRequestWillBeSent(cors.preflight.willBeSent);
      capture.handleResponseReceived(cors.preflight.responseReceived);
      capture.handleLoadingFinished(cors.preflight.loadingFinished);

      // Process actual request
      capture.handleRequestWillBeSent(cors.actual.willBeSent);
      capture.handleResponseReceived(cors.actual.responseReceived);
      capture.handleLoadingFinished(cors.actual.loadingFinished);

      const preflight = capture.getRequest("req_preflight");
      const actual = capture.getRequest("req_actual");

      expect(preflight!.preflightFor).toBe("req_actual");
      expect(actual!.preflightRequestId).toBe("req_preflight");
    });
  });

  describe("resource type classification", () => {
    it("should classify common CDP resource types", () => {
      expect(capture.classifyResourceType("XHR")).toBe("xhr");
      expect(capture.classifyResourceType("Fetch")).toBe("fetch");
      expect(capture.classifyResourceType("Document")).toBe("document");
      expect(capture.classifyResourceType("Stylesheet")).toBe("stylesheet");
      expect(capture.classifyResourceType("Script")).toBe("script");
      expect(capture.classifyResourceType("Image")).toBe("image");
      expect(capture.classifyResourceType("Font")).toBe("font");
      expect(capture.classifyResourceType("WebSocket")).toBe("websocket");
      expect(capture.classifyResourceType("Manifest")).toBe("other");
      expect(capture.classifyResourceType(undefined)).toBe("other");
    });
  });

  describe("timing", () => {
    it("should compute request timing correctly", () => {
      const req = simpleGetRequest();

      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleResponseReceived(req.responseReceived);
      capture.handleLoadingFinished(req.loadingFinished);

      const result = capture.getRequest("req_1");
      expect(result!.timing.startTime).toBeGreaterThan(0);
      expect(result!.timing.responseTime).toBeDefined();
      expect(result!.timing.endTime).toBeDefined();
      expect(result!.timing.duration).toBeDefined();
      expect(result!.timing.duration).toBeGreaterThan(0);
    });
  });

  describe("filtering", () => {
    beforeEach(() => {
      // Populate with various requests
      const get = simpleGetRequest();
      capture.handleRequestWillBeSent(get.willBeSent);
      capture.handleResponseReceived(get.responseReceived);
      capture.handleLoadingFinished(get.loadingFinished);

      const post = loginPostRequest();
      capture.handleRequestWillBeSent(post.willBeSent);
      capture.handleResponseReceived(post.responseReceived);
      capture.handleLoadingFinished(post.loadingFinished);

      const err = failedRequest();
      capture.handleRequestWillBeSent(err.willBeSent);
      capture.handleResponseReceived(err.responseReceived);
      capture.handleLoadingFinished(err.loadingFinished);
    });

    it("should filter by URL pattern", () => {
      const results = capture.getRequests({ urlPattern: "auth" });
      expect(results).toHaveLength(1);
      expect(results[0].url).toContain("auth");
    });

    it("should filter by method", () => {
      const results = capture.getRequests({ method: "POST" });
      expect(results).toHaveLength(1);
      expect(results[0].method).toBe("POST");
    });

    it("should filter by status range", () => {
      const errors = capture.getRequests({ statusMin: 400 });
      expect(errors).toHaveLength(1);
      expect(errors[0].status).toBe(500);
    });

    it("should filter by resource type", () => {
      const fetches = capture.getRequests({ resourceType: "fetch" });
      expect(fetches.length).toBeGreaterThanOrEqual(2);
    });

    it("should apply limit", () => {
      const limited = capture.getRequests({ limit: 1 });
      expect(limited).toHaveLength(1);
    });

    it("should filter by timestamp", () => {
      const all = capture.getRequests();
      const midTime = all[1].timing.startTime;
      const since = capture.getRequests({ sinceTimestamp: midTime });
      expect(since.length).toBeLessThan(all.length);
    });

    it("should handle invalid regex as literal substring match", () => {
      const results = capture.getRequests({ urlPattern: "[invalid" });
      // Should not throw, should use literal match
      expect(results).toBeDefined();
    });
  });

  describe("ring buffer", () => {
    it("should evict oldest requests when buffer is full", () => {
      const smallCapture = new NetworkCapture({ maxRequests: 3 });

      for (let i = 0; i < 5; i++) {
        const wallTime = 1705312245.123 + i;
        const timestamp = 12345.0 + i;
        smallCapture.handleRequestWillBeSent({
          requestId: `req_${i}`,
          request: {
            url: `https://api.example.com/page/${i}`,
            method: "GET",
            headers: {},
          },
          wallTime,
          timestamp,
          initiator: { type: "script" },
        });
        smallCapture.handleResponseReceived({
          requestId: `req_${i}`,
          response: {
            url: `https://api.example.com/page/${i}`,
            status: 200,
            statusText: "OK",
            headers: {},
            mimeType: "text/html",
          },
          timestamp: timestamp + 0.1,
        });
        smallCapture.handleLoadingFinished({
          requestId: `req_${i}`,
          timestamp: timestamp + 0.11,
          encodedDataLength: 100,
        });
      }

      expect(smallCapture.size).toBe(3);
      // Oldest requests should be evicted
      expect(smallCapture.getRequest("req_0")).toBeUndefined();
      expect(smallCapture.getRequest("req_1")).toBeUndefined();
      expect(smallCapture.getRequest("req_2")).toBeDefined();
      expect(smallCapture.getRequest("req_3")).toBeDefined();
      expect(smallCapture.getRequest("req_4")).toBeDefined();
    });
  });

  describe("URL exclusion", () => {
    it("should exclude requests matching exclude patterns", () => {
      const filtered = new NetworkCapture({
        excludePatterns: [/google-analytics/, /sentry\.io/],
      });

      const bg = backgroundRequests();
      for (const req of bg) {
        filtered.handleRequestWillBeSent(req);
      }

      expect(filtered.pendingCount).toBe(0); // Both excluded
    });
  });

  describe("response body handling", () => {
    it("should fetch text response bodies via callback", async () => {
      const req = loginPostRequest();
      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleResponseReceived(req.responseReceived);

      const bodyCallback = async (requestId: string) => ({
        body: req.responseBody,
        base64Encoded: false,
      });

      capture.handleLoadingFinished(req.loadingFinished, bodyCallback);

      // Wait for async body fetch
      await new Promise((r) => setTimeout(r, 50));

      const result = capture.getRequest("req_login");
      expect(result!.responseBody).toContain("access_token");
    });

    it("should truncate large response bodies", () => {
      const smallCapture = new NetworkCapture({ maxResponseBodySize: 50 });
      const req = loginPostRequest();

      smallCapture.handleRequestWillBeSent(req.willBeSent);
      smallCapture.handleResponseReceived(req.responseReceived);

      const largeBody = "x".repeat(200);
      smallCapture.handleLoadingFinished(req.loadingFinished, async () => ({
        body: largeBody,
        base64Encoded: false,
      }));

      // Wait for async body fetch
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const result = smallCapture.getRequest("req_login");
          expect(result!.responseBody!.length).toBeLessThan(200);
          expect(result!.responseBody).toContain("[truncated");
          resolve();
        }, 50);
      });
    });
  });

  describe("clear", () => {
    it("should clear all state", () => {
      const req = simpleGetRequest();
      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleResponseReceived(req.responseReceived);
      capture.handleLoadingFinished(req.loadingFinished);

      expect(capture.size).toBe(1);

      capture.clear();

      expect(capture.size).toBe(0);
      expect(capture.pendingCount).toBe(0);
    });
  });

  describe("onRequestComplete callback", () => {
    it("should fire callback when a request completes", () => {
      const completed: string[] = [];
      capture.onRequestComplete = (request) => {
        completed.push(request.id);
      };

      const req = simpleGetRequest();
      capture.handleRequestWillBeSent(req.willBeSent);
      capture.handleResponseReceived(req.responseReceived);
      capture.handleLoadingFinished(req.loadingFinished);

      expect(completed).toEqual(["req_1"]);
    });
  });
});
