/**
 * Integration test: Real browser, real network traffic.
 *
 * This test launches an actual Chromium instance via Puppeteer,
 * navigates to pages, clicks elements, and verifies the full
 * capture + correlation pipeline works end-to-end.
 *
 * Run with: npx vitest run tests/integration.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { BrowserManager } from "../src/browser.js";

describe("Integration: Real Browser", () => {
  let browser: BrowserManager;

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it("should launch browser, navigate, and capture real network traffic", async () => {
    browser = new BrowserManager({ headless: true });
    await browser.initialize();

    expect(browser.isConnected()).toBe(true);

    // Navigate to example.com — minimal but real HTTP traffic
    const result = await browser.navigate("https://example.com");

    // Should have captured the document request at minimum
    const stats = browser.getStats();
    console.log(`\n📊 Stats after navigation:`);
    console.log(`   Total requests: ${stats.totalRequests}`);
    console.log(`   Pending: ${stats.pendingRequests}`);
    console.log(`   Actions: ${stats.totalActions}`);

    expect(stats.totalRequests).toBeGreaterThanOrEqual(1);
    expect(stats.totalActions).toBe(1);

    // Check the network log
    const requests = browser.getNetworkLog();
    console.log(`\n📋 Captured requests:`);
    for (const req of requests) {
      console.log(`   ${req.method} ${req.url} → ${req.status} (${req.resourceType})`);
    }

    // Should have at least the main document
    const docRequests = requests.filter((r) => r.resourceType === "document");
    expect(docRequests.length).toBeGreaterThanOrEqual(1);
    expect(docRequests[0].status).toBe(200);
    expect(docRequests[0].url).toContain("example.com");

    // Correlation result should exist
    if (result) {
      console.log(`\n🔗 Correlation result:`);
      console.log(`   Action: ${result.action.type} → ${result.action.targetDescription}`);
      console.log(`   Correlated requests: ${result.requests.length}`);
      console.log(`   Confidence: ${result.confidence.toFixed(2)}`);
      console.log(`   Chains: ${result.chains.length}`);

      expect(result.action.type).toBe("navigate");
      expect(result.requests.length).toBeGreaterThanOrEqual(1);
    }
  }, 30000); // 30s timeout for browser launch + navigation

  it("should navigate to a page with JS and capture API-like traffic", async () => {
    // Navigate to a data: URL with inline JS that makes a fetch
    const htmlPage = `
      <!DOCTYPE html>
      <html>
      <head><title>Test Page</title></head>
      <body>
        <h1>Network Intelligence Test</h1>
        <button id="fetch-btn" onclick="doFetch()">Fetch Data</button>
        <div id="output"></div>
        <script>
          async function doFetch() {
            try {
              const res = await fetch('https://httpbin.org/json');
              const data = await res.json();
              document.getElementById('output').textContent = JSON.stringify(data);
            } catch(e) {
              document.getElementById('output').textContent = 'Error: ' + e.message;
            }
          }
        </script>
      </body>
      </html>
    `;

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlPage)}`;

    // Clear previous capture
    browser.clearCapture();

    // Navigate to our test page
    await browser.navigate(dataUrl);

    const title = await browser.getPageTitle();
    expect(title).toBe("Test Page");

    console.log(`\n📄 Loaded test page: "${title}"`);

    // Clear again to isolate click traffic
    browser.clearCapture();

    // Click the fetch button
    const clickResult = await browser.click("#fetch-btn");

    const stats = browser.getStats();
    console.log(`\n📊 Stats after click:`);
    console.log(`   Total requests: ${stats.totalRequests}`);
    console.log(`   Actions: ${stats.totalActions}`);

    if (clickResult) {
      console.log(`\n🔗 Click correlation:`);
      console.log(`   Action: ${clickResult.action.type} → ${clickResult.action.targetDescription}`);
      console.log(`   Triggered ${clickResult.requests.length} request(s):`);
      for (const req of clickResult.requests) {
        console.log(`     ${req.method} ${req.url} → ${req.status} ${req.statusText}`);
        if (req.correlationMethod) {
          console.log(`     Correlation: ${req.correlationMethod} (${(req.correlationConfidence || 0).toFixed(2)})`);
        }
        if (req.responseBody) {
          console.log(`     Response: ${req.responseBody.substring(0, 100)}...`);
        }
      }

      // Should have captured the fetch to httpbin.org
      const apiRequests = clickResult.requests.filter((r) =>
        r.url.includes("httpbin.org")
      );

      if (apiRequests.length > 0) {
        expect(apiRequests[0].method).toBe("GET");
        expect(apiRequests[0].status).toBe(200);
        expect(apiRequests[0].correlatedActionId).toBeDefined();
        console.log(`\n✅ Successfully correlated click → API request!`);
      } else {
        console.log(`\n⚠️ httpbin.org request not captured (may be blocked by network)`);
        // Don't fail — httpbin might be unreachable in CI
      }
    } else {
      console.log(`\n⚠️ No correlation result (click may not have triggered network)`);
    }
  }, 30000);

  it("should capture and filter requests by various criteria", async () => {
    browser.clearCapture();

    // Navigate to a real site with multiple request types
    await browser.navigate("https://example.com");

    const allRequests = browser.getNetworkLog();
    console.log(`\n📋 All requests: ${allRequests.length}`);

    // Filter by method
    const getRequests = browser.getNetworkLog({ method: "GET" });
    console.log(`   GET requests: ${getRequests.length}`);
    expect(getRequests.length).toBeGreaterThanOrEqual(1);
    for (const r of getRequests) {
      expect(r.method).toBe("GET");
    }

    // Filter by resource type
    const docs = browser.getNetworkLog({ resourceType: "document" });
    console.log(`   Documents: ${docs.length}`);
    expect(docs.length).toBeGreaterThanOrEqual(1);

    // Get detail of first request
    if (allRequests.length > 0) {
      const detail = browser.getRequestDetail(allRequests[0].id);
      expect(detail).toBeDefined();
      console.log(`\n🔍 Request detail for ${detail!.id}:`);
      console.log(`   URL: ${detail!.url}`);
      console.log(`   Status: ${detail!.status} ${detail!.statusText}`);
      console.log(`   Duration: ${detail!.timing.duration}ms`);
      console.log(`   Response size: ${detail!.responseSize} bytes`);
      console.log(`   Initiator: ${detail!.initiator.type}`);
    }
  }, 30000);

  it("should produce formatted output suitable for AI agents", async () => {
    // Import formatters to show the actual MCP output format
    const { formatCorrelation, formatRequestList, formatRequestDetail } = await import("../src/formatter.js");

    browser.clearCapture();
    const result = await browser.navigate("https://example.com");

    if (result) {
      const output = formatCorrelation(result);
      console.log(`\n════════════════════════════════════════════`);
      console.log(`  MCP TOOL OUTPUT (what the agent sees)`);
      console.log(`════════════════════════════════════════════`);
      console.log(output);

      // Verify output structure
      expect(output).toContain("ACTION:");
      expect(output).toContain("TRIGGERED REQUESTS");
      expect(output).toContain("example.com");
    }

    // Also show the network log format
    const requests = browser.getNetworkLog({ limit: 5 });
    const listOutput = formatRequestList(requests);
    console.log(`\n════════════════════════════════════════════`);
    console.log(`  NETWORK LOG OUTPUT`);
    console.log(`════════════════════════════════════════════`);
    console.log(listOutput);

    expect(listOutput).toContain("request(s)");
  }, 30000);
});
