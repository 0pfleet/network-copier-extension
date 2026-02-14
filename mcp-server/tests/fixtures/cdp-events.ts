/**
 * Realistic CDP event fixtures for testing.
 *
 * These model real-world scenarios like login flows, SPA navigations,
 * API calls, redirect chains, and CORS preflights.
 */

import type {
  CDPRequestWillBeSent,
  CDPResponseReceived,
  CDPLoadingFinished,
} from "../../src/types.js";

// ── Helper: Create timestamps ──

let baseWallTime = 1705312245.123; // 2024-01-15T10:30:45.123Z
let baseTimestamp = 12345.0;

export function resetTimestamps(): void {
  baseWallTime = 1705312245.123;
  baseTimestamp = 12345.0;
}

function ts(offsetMs: number): { wallTime: number; timestamp: number } {
  return {
    wallTime: baseWallTime + offsetMs / 1000,
    timestamp: baseTimestamp + offsetMs / 1000,
  };
}

// ── Scenario 1: Simple API GET ──

export function simpleGetRequest(): {
  willBeSent: CDPRequestWillBeSent;
  responseReceived: CDPResponseReceived;
  loadingFinished: CDPLoadingFinished;
} {
  const times = ts(0);
  return {
    willBeSent: {
      requestId: "req_1",
      request: {
        url: "https://api.example.com/users",
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      },
      ...times,
      initiator: { type: "script" },
      type: "Fetch",
    },
    responseReceived: {
      requestId: "req_1",
      response: {
        url: "https://api.example.com/users",
        status: 200,
        statusText: "OK",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "1234",
        },
        mimeType: "application/json",
      },
      timestamp: times.timestamp + 0.089,
      type: "Fetch",
    },
    loadingFinished: {
      requestId: "req_1",
      timestamp: times.timestamp + 0.095,
      encodedDataLength: 1234,
    },
  };
}

// ── Scenario 2: Login POST with stack trace ──

export function loginPostRequest(): {
  willBeSent: CDPRequestWillBeSent;
  responseReceived: CDPResponseReceived;
  loadingFinished: CDPLoadingFinished;
  responseBody: string;
} {
  const times = ts(100);
  return {
    willBeSent: {
      requestId: "req_login",
      request: {
        url: "https://api.example.com/auth/login",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        postData: JSON.stringify({
          email: "user@example.com",
          password: "secret123",
        }),
      },
      ...times,
      initiator: {
        type: "script",
        stack: {
          callFrames: [
            {
              functionName: "",
              scriptId: "42",
              url: "https://app.example.com/LoginForm.js",
              lineNumber: 45,
              columnNumber: 10,
            },
          ],
          parent: {
            description: "await",
            callFrames: [
              {
                functionName: "handleSubmit",
                scriptId: "42",
                url: "https://app.example.com/LoginForm.js",
                lineNumber: 30,
                columnNumber: 5,
              },
            ],
            parent: {
              description: "click",
              callFrames: [
                {
                  functionName: "onClick",
                  scriptId: "42",
                  url: "https://app.example.com/LoginForm.js",
                  lineNumber: 22,
                  columnNumber: 3,
                },
              ],
            },
          },
        },
      },
      type: "Fetch",
    },
    responseReceived: {
      requestId: "req_login",
      response: {
        url: "https://api.example.com/auth/login",
        status: 200,
        statusText: "OK",
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "session=abc123; HttpOnly; Secure",
        },
        mimeType: "application/json",
      },
      timestamp: times.timestamp + 0.312,
      type: "Fetch",
    },
    loadingFinished: {
      requestId: "req_login",
      timestamp: times.timestamp + 0.315,
      encodedDataLength: 256,
    },
    responseBody: JSON.stringify({
      access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
      user: { id: 42, name: "Oscar" },
    }),
  };
}

// ── Scenario 3: Redirect chain (301 → 302 → 200) ──

export function redirectChain(): {
  events: Array<{
    type: "willBeSent" | "responseReceived" | "loadingFinished";
    data: CDPRequestWillBeSent | CDPResponseReceived | CDPLoadingFinished;
  }>;
} {
  const t1 = ts(200);
  const t2 = ts(250);
  const t3 = ts(300);
  const t4 = ts(350);

  return {
    events: [
      // Initial request
      {
        type: "willBeSent",
        data: {
          requestId: "req_redirect",
          request: {
            url: "https://example.com/old-page",
            method: "GET",
            headers: {},
          },
          ...t1,
          initiator: { type: "other" },
          type: "Document",
        } as CDPRequestWillBeSent,
      },
      // First redirect (301)
      {
        type: "willBeSent",
        data: {
          requestId: "req_redirect",
          request: {
            url: "https://example.com/new-page",
            method: "GET",
            headers: {},
          },
          ...t2,
          initiator: { type: "other" },
          redirectResponse: {
            status: 301,
            headers: { Location: "https://example.com/new-page" },
            statusText: "Moved Permanently",
          },
          type: "Document",
        } as CDPRequestWillBeSent,
      },
      // Second redirect (302)
      {
        type: "willBeSent",
        data: {
          requestId: "req_redirect",
          request: {
            url: "https://example.com/final-page",
            method: "GET",
            headers: {},
          },
          ...t3,
          initiator: { type: "other" },
          redirectResponse: {
            status: 302,
            headers: { Location: "https://example.com/final-page" },
            statusText: "Found",
          },
          type: "Document",
        } as CDPRequestWillBeSent,
      },
      // Final response
      {
        type: "responseReceived",
        data: {
          requestId: "req_redirect",
          response: {
            url: "https://example.com/final-page",
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "text/html" },
            mimeType: "text/html",
          },
          timestamp: t4.timestamp,
          type: "Document",
        } as CDPResponseReceived,
      },
      {
        type: "loadingFinished",
        data: {
          requestId: "req_redirect",
          timestamp: t4.timestamp + 0.05,
          encodedDataLength: 5000,
        } as CDPLoadingFinished,
      },
    ],
  };
}

// ── Scenario 4: CORS preflight + actual request ──

export function corsPreflightPair(): {
  preflight: {
    willBeSent: CDPRequestWillBeSent;
    responseReceived: CDPResponseReceived;
    loadingFinished: CDPLoadingFinished;
  };
  actual: {
    willBeSent: CDPRequestWillBeSent;
    responseReceived: CDPResponseReceived;
    loadingFinished: CDPLoadingFinished;
  };
} {
  const t1 = ts(400);
  const t2 = ts(420);

  return {
    preflight: {
      willBeSent: {
        requestId: "req_preflight",
        request: {
          url: "https://api.example.com/data",
          method: "OPTIONS",
          headers: {
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type, Authorization",
          },
        },
        ...t1,
        initiator: {
          type: "preflight",
          requestId: "req_actual",
        },
        type: "Other",
      },
      responseReceived: {
        requestId: "req_preflight",
        response: {
          url: "https://api.example.com/data",
          status: 204,
          statusText: "No Content",
          headers: {
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
          mimeType: "",
        },
        timestamp: t1.timestamp + 0.015,
      },
      loadingFinished: {
        requestId: "req_preflight",
        timestamp: t1.timestamp + 0.016,
        encodedDataLength: 0,
      },
    },
    actual: {
      willBeSent: {
        requestId: "req_actual",
        request: {
          url: "https://api.example.com/data",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.test",
          },
          postData: JSON.stringify({ query: "SELECT * FROM users" }),
        },
        ...t2,
        initiator: { type: "script" },
        type: "Fetch",
      },
      responseReceived: {
        requestId: "req_actual",
        response: {
          url: "https://api.example.com/data",
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          mimeType: "application/json",
        },
        timestamp: t2.timestamp + 0.1,
      },
      loadingFinished: {
        requestId: "req_actual",
        timestamp: t2.timestamp + 0.105,
        encodedDataLength: 2048,
      },
    },
  };
}

// ── Scenario 5: Analytics/tracking requests (should be classified as background) ──

export function backgroundRequests(): CDPRequestWillBeSent[] {
  return [
    {
      requestId: "req_analytics",
      request: {
        url: "https://www.google-analytics.com/collect?v=1&tid=UA-123",
        method: "POST",
        headers: {},
      },
      ...ts(500),
      initiator: { type: "script" },
      type: "XHR",
    },
    {
      requestId: "req_sentry",
      request: {
        url: "https://sentry.io/api/123/envelope/",
        method: "POST",
        headers: {},
      },
      ...ts(510),
      initiator: { type: "script" },
      type: "Fetch",
    },
  ];
}

// ── Scenario 6: Failed request ──

export function failedRequest(): {
  willBeSent: CDPRequestWillBeSent;
  responseReceived: CDPResponseReceived;
  loadingFinished: CDPLoadingFinished;
} {
  const times = ts(600);
  return {
    willBeSent: {
      requestId: "req_error",
      request: {
        url: "https://api.example.com/broken",
        method: "GET",
        headers: {},
      },
      ...times,
      initiator: { type: "script" },
      type: "Fetch",
    },
    responseReceived: {
      requestId: "req_error",
      response: {
        url: "https://api.example.com/broken",
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "application/json" },
        mimeType: "application/json",
      },
      timestamp: times.timestamp + 0.5,
      type: "Fetch",
    },
    loadingFinished: {
      requestId: "req_error",
      timestamp: times.timestamp + 0.505,
      encodedDataLength: 128,
    },
  };
}

// ── Scenario 7: Image request (binary, should skip body) ──

export function imageRequest(): {
  willBeSent: CDPRequestWillBeSent;
  responseReceived: CDPResponseReceived;
  loadingFinished: CDPLoadingFinished;
} {
  const times = ts(700);
  return {
    willBeSent: {
      requestId: "req_image",
      request: {
        url: "https://cdn.example.com/avatar/42.jpg",
        method: "GET",
        headers: {},
      },
      ...times,
      initiator: { type: "parser", url: "https://app.example.com/" },
      type: "Image",
    },
    responseReceived: {
      requestId: "req_image",
      response: {
        url: "https://cdn.example.com/avatar/42.jpg",
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "image/jpeg" },
        mimeType: "image/jpeg",
      },
      timestamp: times.timestamp + 0.156,
      type: "Image",
    },
    loadingFinished: {
      requestId: "req_image",
      timestamp: times.timestamp + 0.16,
      encodedDataLength: 45000,
    },
  };
}
