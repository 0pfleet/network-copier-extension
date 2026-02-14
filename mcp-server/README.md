# Network Intelligence MCP Server

An MCP server that gives AI agents **network-level understanding** of browser traffic. Not just "what the page looks like" but "what requests fired, why, and what they returned."

## The Problem

AI agents are blind to the network layer. They see DOM and screenshots but can't see:
- What API calls a page makes
- What a button click triggers behind the scenes
- Why a login failed (was it a 401? CORS? Network error?)
- The full request/response chain of an auth flow

## The Solution

This MCP server launches a browser, captures all network traffic via CDP, and **correlates user actions to the requests they trigger**. When the agent clicks a login button, it sees:

```
ACTION: Click on button "Sign In" (#login-btn)

TRIGGERED REQUESTS (3):

[1] POST https://api.example.com/auth/login
    Status: 200 OK (312ms)
    Request Body: {"email": "user@example.com", "password": "[REDACTED]"}
    Response Body: {"access_token": "eyJhbG...", "user": {"id": 42}}

[2] GET https://api.example.com/user/profile
    Status: 200 OK (89ms)
    Response Body: {"id": 42, "name": "Oscar", "role": "engineer"}

[3] GET https://api.example.com/dashboard
    Status: 200 OK (134ms)

REQUEST CHAINS:
  AUTH_FLOW: POST /auth/login -> token -> 2 authenticated request(s)
```

## Quick Start

### Configure in Claude Code

Add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "network-intelligence": {
      "command": "node",
      "args": ["/path/to/mcp-server/build/index.js"]
    }
  }
}
```

Or when published:

```json
{
  "mcpServers": {
    "network-intelligence": {
      "command": "npx",
      "args": ["@0pfleet/network-intelligence-mcp"]
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NI_HEADLESS` | `true` | Set to `false` to see the browser window |
| `NI_BROWSER_URL` | — | Connect to existing browser (e.g., `http://127.0.0.1:9222`) |

## MCP Tools

### `browser_navigate`

Navigate to a URL and capture all resulting network traffic.

```
Input: { url: "https://example.com" }
Output: Correlated navigation action with all triggered requests
```

### `browser_click`

Click an element and capture all network requests triggered by the click.

```
Input: { selector: "#login-btn" }
Output: Correlated click action with triggered API calls
```

### `browser_type`

Type text into an input field, capturing any triggered requests (search autocomplete, validation).

```
Input: { selector: "input[name=email]", text: "user@example.com" }
Output: Any requests triggered by typing (e.g., debounced search)
```

### `get_network_log`

Query the captured network history with filters.

```
Input: {
  url_pattern: "/api/",      // Regex filter
  method: "POST",            // HTTP method
  status_min: 400,           // Errors only
  resource_type: "fetch",    // XHR/Fetch only
  limit: 20
}
Output: Filtered list of captured requests
```

### `get_request_detail`

Get full details of a specific request including headers, bodies, timing, initiator stack trace, and correlation data.

```
Input: { request_id: "req_123" }
Output: Complete request detail with stack trace and chain info
```

### `clear_capture`

Reset the capture buffer for a fresh session.

## Architecture

```
Claude Code  ──[stdio/MCP]──>  MCP Server (Node.js)
                                     │
                                     ├── Puppeteer (browser management)
                                     ├── CDP Network domain (request capture)
                                     ├── Correlator (action → request mapping)
                                     └── Formatter (agent-friendly output)
```

### Correlation Engine

The core differentiator. Uses a 4-layer approach:

| Layer | Method | Confidence | How |
|-------|--------|:---:|-----|
| 0 | Preflight inheritance | 0.85 | CORS preflight inherits from actual request |
| 1 | CDP stack traces | 0.90-0.95 | Async stack trace walks back to `click`/`submit` event |
| 2 | Timing + semantics | 0.50-0.80 | Time proximity + "Login" button + POST /auth = match |
| 3 | Timing only | 0.20-0.50 | Request within 2s of action |
| 4 | Chain membership | 0.50-0.85 | Preflight, redirect, or sequential dependency |

### Chain Detection

Automatically detects:
- **Redirect chains**: 301 → 302 → 200
- **CORS preflights**: OPTIONS → POST
- **Auth flows**: POST /login → JWT → authenticated GET requests
- **Sequential dependencies**: Request B fires right after A completes

### Sensitive Data Handling

- Passwords in request bodies are redacted (`[REDACTED]`)
- Authorization headers are partially redacted
- Cookie values are redacted
- Sensitive field names (password, token, ssn, cvv, etc.) are detected and redacted

## Development

```bash
cd mcp-server
npm install
npm run build      # Compile TypeScript
npm test           # Run 63 unit tests
npm run test:watch # Watch mode
npm run lint       # Type-check
```

### Test Structure

```
tests/
  fixtures/
    cdp-events.ts       # Realistic CDP event fixtures (login, redirect, CORS, etc.)
  network.test.ts       # 22 tests: capture lifecycle, filtering, ring buffer, timing
  correlator.test.ts    # 20 tests: stack traces, scoring, chain detection, edge cases
  formatter.test.ts     # 21 tests: output formatting, redaction, JSON pretty-print
```

## License

MIT
