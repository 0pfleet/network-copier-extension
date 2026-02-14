#!/usr/bin/env node

/**
 * Network Intelligence MCP Server
 *
 * Gives AI agents network-level understanding of browser traffic.
 * Captures requests, correlates them to user actions, and provides
 * agent-friendly structured output.
 *
 * Usage:
 *   npx @0pfleet/network-intelligence-mcp
 *
 * Configure in Claude Code's .claude/mcp.json:
 *   {
 *     "mcpServers": {
 *       "network-intelligence": {
 *         "command": "npx",
 *         "args": ["@0pfleet/network-intelligence-mcp"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserManager } from "./browser.js";
import {
  formatCorrelation,
  formatRequestList,
  formatRequestDetail,
} from "./formatter.js";
import type { NetworkFilter, ResourceType } from "./types.js";

// ── Server Setup ──

const server = new McpServer({
  name: "network-intelligence",
  version: "0.1.0",
});

let browserManager: BrowserManager | null = null;

async function ensureBrowser(): Promise<BrowserManager> {
  if (!browserManager || !browserManager.isConnected()) {
    browserManager = new BrowserManager({
      headless: process.env.NI_HEADLESS !== "false",
      mode:
        process.env.NI_BROWSER_URL ? "connect" : "launch",
      browserUrl: process.env.NI_BROWSER_URL,
    });
    await browserManager.initialize();
  }
  return browserManager;
}

// ── Tool: browser_navigate ──

server.tool(
  "browser_navigate",
  "Navigate to a URL and capture all resulting network traffic. Returns correlated action-to-request data showing which requests were triggered by the navigation.",
  {
    url: z.string().url().describe("The URL to navigate to"),
  },
  async ({ url }) => {
    try {
      const browser = await ensureBrowser();
      const result = await browser.navigate(url);

      const pageTitle = await browser.getPageTitle();
      const stats = browser.getStats();

      let output = `Navigated to: ${url}\n`;
      output += `Page title: ${pageTitle}\n`;
      output += `Total requests captured: ${stats.totalRequests}\n\n`;

      if (result) {
        output += formatCorrelation(result);
      } else {
        const requests = browser.getNetworkLog({ limit: 50 });
        output += formatRequestList(requests);
      }

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Navigation failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: browser_click ──

server.tool(
  "browser_click",
  "Click an element on the page and capture all network requests triggered by the click. Returns the correlated requests showing what API calls the click caused.",
  {
    selector: z
      .string()
      .describe("CSS selector for the element to click (e.g., '#login-btn', 'button.submit')"),
  },
  async ({ selector }) => {
    try {
      const browser = await ensureBrowser();
      const result = await browser.click(selector);

      let output = `Clicked: ${selector}\n\n`;

      if (result) {
        output += formatCorrelation(result);
      } else {
        output += "No network requests were triggered by this click.";
      }

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Click failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: browser_type ──

server.tool(
  "browser_type",
  "Type text into an input field. Captures any network requests triggered by the typing (e.g., search autocomplete, form validation).",
  {
    selector: z
      .string()
      .describe("CSS selector for the input element"),
    text: z.string().describe("Text to type into the element"),
  },
  async ({ selector, text }) => {
    try {
      const browser = await ensureBrowser();
      const result = await browser.type(selector, text);

      let output = `Typed "${text}" into ${selector}\n\n`;

      if (result) {
        output += formatCorrelation(result);
      } else {
        output += "No network requests were triggered by typing.";
      }

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Type failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: get_network_log ──

const VALID_RESOURCE_TYPES: ResourceType[] = [
  "xhr", "fetch", "document", "stylesheet", "script", "image", "font", "websocket", "other",
];

server.tool(
  "get_network_log",
  "Get captured network requests with optional filtering. Use this to query the full network history, filter by URL pattern, method, status code, or resource type.",
  {
    url_pattern: z
      .string()
      .optional()
      .describe("Regex pattern to filter URLs (e.g., '/api/', 'graphql')"),
    method: z
      .string()
      .optional()
      .describe("HTTP method filter (GET, POST, PUT, DELETE, etc.)"),
    status_min: z
      .number()
      .optional()
      .describe("Minimum status code (e.g., 400 for errors only)"),
    status_max: z
      .number()
      .optional()
      .describe("Maximum status code"),
    resource_type: z
      .enum(VALID_RESOURCE_TYPES as [string, ...string[]])
      .optional()
      .describe("Resource type filter (xhr, fetch, document, etc.)"),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Maximum number of results (default: 50)"),
  },
  async ({ url_pattern, method, status_min, status_max, resource_type, limit }) => {
    try {
      const browser = await ensureBrowser();

      const filter: NetworkFilter = {
        urlPattern: url_pattern,
        method,
        statusMin: status_min,
        statusMax: status_max,
        resourceType: resource_type as ResourceType | undefined,
        limit,
      };

      const requests = browser.getNetworkLog(filter);
      const stats = browser.getStats();

      let output = `Showing ${requests.length} of ${stats.totalRequests} total captured requests\n`;
      if (url_pattern) output += `URL filter: ${url_pattern}\n`;
      if (method) output += `Method filter: ${method}\n`;
      if (status_min || status_max)
        output += `Status filter: ${status_min || "*"}-${status_max || "*"}\n`;
      output += "\n";

      output += formatRequestList(requests, {
        includeResponseBody: true,
        includeRequestBody: true,
        maxBodyLength: 2000,
      });

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get network log: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: get_request_detail ──

server.tool(
  "get_request_detail",
  "Get full details of a specific network request, including headers, body, timing, initiator stack trace, and correlation data. Use the request ID from get_network_log results.",
  {
    request_id: z.string().describe("The request ID to look up"),
  },
  async ({ request_id }) => {
    try {
      const browser = await ensureBrowser();
      const request = browser.getRequestDetail(request_id);

      if (!request) {
        return {
          content: [
            {
              type: "text",
              text: `Request not found: ${request_id}. Use get_network_log to see available request IDs.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatRequestDetail(request) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get request detail: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: clear_capture ──

server.tool(
  "clear_capture",
  "Clear all captured network requests and action history. Useful for starting a fresh capture session.",
  {},
  async () => {
    try {
      const browser = await ensureBrowser();
      browser.clearCapture();
      return {
        content: [{ type: "text", text: "Capture cleared. Ready for new requests." }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to clear: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Start Server ──

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  // Clean up browser on exit
  process.on("SIGINT", async () => {
    await browserManager?.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await browserManager?.close();
    process.exit(0);
  });

  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
