/**
 * Browser management module.
 *
 * Handles Puppeteer browser launch/connection, CDP session management,
 * and high-level page interaction methods that automatically capture
 * and correlate network traffic.
 */

import puppeteer, {
  type Browser,
  type Page,
  type CDPSession,
} from "puppeteer";
import { NetworkCapture, type NetworkCaptureOptions } from "./network.js";
import { Correlator, type CorrelationOptions } from "./correlator.js";
import type {
  TrackedAction,
  CDPRequestWillBeSent,
  CDPResponseReceived,
  CDPLoadingFinished,
  CorrelationResult,
  CapturedRequest,
  NetworkFilter,
} from "./types.js";

export interface BrowserManagerOptions {
  /** Launch a new browser or connect to existing */
  mode?: "launch" | "connect";

  /** URL to connect to (for mode: "connect") */
  browserUrl?: string;

  /** Run browser in headless mode */
  headless?: boolean;

  /** Network capture options */
  capture?: NetworkCaptureOptions;

  /** Correlation options */
  correlation?: CorrelationOptions;
}

const DEFAULT_BROWSER_OPTIONS: Required<BrowserManagerOptions> = {
  mode: "launch",
  browserUrl: "http://127.0.0.1:9222",
  headless: true,
  capture: {},
  correlation: {},
};

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private capture: NetworkCapture;
  private correlator: Correlator;
  private options: Required<BrowserManagerOptions>;
  private actionCounter = 0;

  constructor(options?: BrowserManagerOptions) {
    this.options = { ...DEFAULT_BROWSER_OPTIONS, ...options };
    this.capture = new NetworkCapture(this.options.capture);
    this.correlator = new Correlator(this.options.correlation);
  }

  /**
   * Launch or connect to a browser and set up network capture.
   */
  async initialize(): Promise<void> {
    if (this.options.mode === "connect") {
      this.browser = await puppeteer.connect({
        browserURL: this.options.browserUrl,
      });
    } else {
      this.browser = await puppeteer.launch({
        headless: this.options.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
    }

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());

    await this.setupCDP();
  }

  /**
   * Set up CDP session and attach Network domain listeners.
   */
  private async setupCDP(): Promise<void> {
    if (!this.page) throw new Error("No page available");

    this.cdpSession = await this.page.createCDPSession();

    // Enable Network domain
    await this.cdpSession.send("Network.enable");

    // Enable async stack traces (critical for correlation)
    await this.cdpSession.send("Debugger.enable");
    await this.cdpSession.send("Debugger.setAsyncCallStackDepth", {
      maxDepth: 32,
    });

    // Attach CDP event handlers
    this.cdpSession.on(
      "Network.requestWillBeSent",
      (params: CDPRequestWillBeSent) => {
        this.capture.handleRequestWillBeSent(params);
      }
    );

    this.cdpSession.on(
      "Network.responseReceived",
      (params: CDPResponseReceived) => {
        this.capture.handleResponseReceived(params);
      }
    );

    this.cdpSession.on(
      "Network.loadingFinished",
      (params: CDPLoadingFinished) => {
        this.capture.handleLoadingFinished(params, async (requestId) => {
          try {
            const result = await this.cdpSession!.send(
              "Network.getResponseBody",
              { requestId }
            );
            return result as { body: string; base64Encoded: boolean };
          } catch {
            return null;
          }
        });
      }
    );

    this.cdpSession.on(
      "Network.loadingFailed",
      (params: { requestId: string; errorText: string; timestamp: number }) => {
        this.capture.handleLoadingFailed(params);
      }
    );
  }

  /**
   * Navigate to a URL and wait for network quiescence.
   * Returns correlated network data.
   */
  async navigate(url: string): Promise<CorrelationResult | null> {
    if (!this.page) throw new Error("Browser not initialized");

    const action = this.createAction("navigate", url, `Navigate to ${url}`);
    this.correlator.recordAction(action);

    await this.page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait a bit for any remaining async requests
    await this.waitForNetworkQuiet(500);

    return this.correlator.correlateAction(
      action.id,
      this.capture.getRequests()
    );
  }

  /**
   * Click an element and capture resulting network requests.
   */
  async click(selector: string): Promise<CorrelationResult | null> {
    if (!this.page) throw new Error("Browser not initialized");

    // Get element description before clicking
    const description = await this.getElementDescription(selector);
    const action = this.createAction(
      "click",
      selector,
      description || `Element: ${selector}`
    );
    this.correlator.recordAction(action);

    const preClickTimestamp = Date.now();

    await this.page.click(selector);

    // Wait for network activity triggered by the click
    await this.waitForNetworkQuiet(1000);

    // Get requests that fired after the click
    const requestsSinceClick = this.capture.getRequestsSince(preClickTimestamp);

    return this.correlator.correlateAction(
      action.id,
      requestsSinceClick.length > 0
        ? requestsSinceClick
        : this.capture.getRequests()
    );
  }

  /**
   * Type text into an input field.
   */
  async type(
    selector: string,
    text: string,
    options?: { delay?: number }
  ): Promise<CorrelationResult | null> {
    if (!this.page) throw new Error("Browser not initialized");

    const description = await this.getElementDescription(selector);
    const action = this.createAction(
      "type",
      selector,
      description || `Input: ${selector}`
    );
    this.correlator.recordAction(action);

    const preTypeTimestamp = Date.now();

    await this.page.type(selector, text, { delay: options?.delay || 50 });

    // Typing usually triggers debounced requests, wait longer
    await this.waitForNetworkQuiet(800);

    const requestsSinceType = this.capture.getRequestsSince(preTypeTimestamp);

    return this.correlator.correlateAction(
      action.id,
      requestsSinceType.length > 0
        ? requestsSinceType
        : this.capture.getRequests()
    );
  }

  /**
   * Get the network capture log, optionally filtered.
   */
  getNetworkLog(filter?: NetworkFilter): CapturedRequest[] {
    return this.capture.getRequests(filter);
  }

  /**
   * Get detailed info about a specific request.
   */
  getRequestDetail(requestId: string): CapturedRequest | undefined {
    return this.capture.getRequest(requestId);
  }

  /**
   * Get all correlation results.
   */
  getAllCorrelations(): CorrelationResult[] {
    return this.correlator.correlateAll(this.capture.getRequests());
  }

  /**
   * Clear all captured data.
   */
  clearCapture(): void {
    this.capture.clear();
    this.correlator.clear();
    this.actionCounter = 0;
  }

  /**
   * Get current page URL.
   */
  async getCurrentUrl(): Promise<string> {
    if (!this.page) throw new Error("Browser not initialized");
    return this.page.url();
  }

  /**
   * Get current page title.
   */
  async getPageTitle(): Promise<string> {
    if (!this.page) throw new Error("Browser not initialized");
    return this.page.title();
  }

  /**
   * Get capture stats.
   */
  getStats(): {
    totalRequests: number;
    pendingRequests: number;
    totalActions: number;
  } {
    return {
      totalRequests: this.capture.size,
      pendingRequests: this.capture.pendingCount,
      totalActions: this.correlator.getActions().length,
    };
  }

  /**
   * Close the browser.
   */
  async close(): Promise<void> {
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.page = null;
  }

  /**
   * Check if browser is still connected.
   */
  isConnected(): boolean {
    return this.browser?.connected ?? false;
  }

  // ── Internal Helpers ──

  private createAction(
    type: TrackedAction["type"],
    selector: string,
    description: string
  ): TrackedAction {
    return {
      id: `action_${++this.actionCounter}`,
      type,
      selector,
      targetDescription: description,
      timestamp: Date.now(),
      pageUrl: this.page?.url() || "",
      resultingRequestIds: [],
    };
  }

  private async getElementDescription(
    selector: string
  ): Promise<string | null> {
    if (!this.page) return null;

    try {
      return await this.page.$eval(selector, (el: Element) => {
        const tag = el.tagName.toLowerCase();
        const text =
          (el as HTMLElement).innerText?.substring(0, 50)?.trim() || "";
        const type = el.getAttribute("type") || "";
        const role = el.getAttribute("role") || "";

        let desc = tag;
        if (el.id) desc += `#${el.id}`;
        if (text) desc += ` "${text}"`;
        if (type) desc += ` [type=${type}]`;
        if (role) desc += ` [role=${role}]`;

        return desc;
      });
    } catch {
      return null;
    }
  }

  private async waitForNetworkQuiet(
    quietPeriodMs: number = 500,
    timeoutMs: number = 10000
  ): Promise<void> {
    const startTime = Date.now();
    let lastActivityTime = Date.now();
    let lastPending = this.capture.pendingCount;

    const checkInterval = 100;

    return new Promise<void>((resolve) => {
      const check = () => {
        const now = Date.now();
        const currentPending = this.capture.pendingCount;

        // Track any change in pending count (up or down) as activity
        if (currentPending !== lastPending) {
          lastActivityTime = now;
          lastPending = currentPending;
        }

        // Require both: no activity for quietPeriodMs AND zero pending requests
        if (currentPending === 0 && now - lastActivityTime >= quietPeriodMs) {
          resolve();
          return;
        }

        if (now - startTime >= timeoutMs) {
          resolve();
          return;
        }

        setTimeout(check, checkInterval);
      };

      setTimeout(check, checkInterval);
    });
  }
}
