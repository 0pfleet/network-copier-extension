# Network Intelligence for AI Agents: Implementation Plan

## Vision

Give AI agents **true network-level understanding** — not just "what the page looks like" but "what requests fired, why, and what they returned."

**Current state**: Agents see screenshots/DOM, are blind to network layer
**Goal state**: Agent can say "clicking Login triggered POST /api/auth → 200 with JWT token"

---

## Research Findings Summary

### The Core Problem
- Agents operate as "UI automation bots" — they see rendered output, not network I/O
- Chrome DevTools MCP helps but requires separate Chrome instance with `--remote-debugging-port`
- No solution exists for "understand the network in my current browser session"

### Key Insights

1. **Extensions are 10x easier than raw CDP** for user-facing targeting
   - `chrome.devtools.inspectedWindow.tabId` gives immediate tab access
   - No discovery queries, no WebSocket URL parsing
   - Can expose relay on localhost that abstracts CDP complexity

2. **Action → Network correlation is solvable**
   - CDP `Network.requestWillBeSent` has `initiator` with stack traces
   - Can attribute requests to clicks, navigations, form submits
   - Cypress-style aliasing pattern: mark action, wait for specific request

3. **Two distribution channels exist**
   - **MCP Registry** (registry.modelcontextprotocol.io) for tools
   - **SKILL.md format** for guidance/workflows
   - Can publish both: MCP server for capabilities, Skill for "how to use"

4. **Browser MCP exists but has gaps**
   - Uses extension + MCP hybrid (closest to our vision)
   - Doesn't focus on network understanding specifically
   - No action→request correlation

---

## Architecture: Dual Approach

### Option A: Extension + Local Bridge (User's Browser)

```
┌─────────────────────────────────────────────────────────┐
│                    User's Chrome                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           Network Intelligence Extension         │   │
│  │  • Captures all requests via chrome.debugger    │   │
│  │  • Correlates actions → requests                │   │
│  │  • Exposes WebSocket server on localhost:9876   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                    WebSocket
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   AI Agent (Claude Code)                 │
│  • Connects to ws://localhost:9876                      │
│  • Sends commands: "start_capture", "get_requests"     │
│  • Receives: structured network data with correlation  │
└─────────────────────────────────────────────────────────┘
```

**Pros**: Works with user's existing browser, preserves auth, no separate instance
**Cons**: Requires extension installation

### Option B: MCP Server + Managed Browser

```
┌─────────────────────────────────────────────────────────┐
│              Network Intelligence MCP Server             │
│  • Launches Chrome with --remote-debugging-port        │
│  • Provides tools: navigate, click, get_network        │
│  • Correlates actions → requests automatically         │
│  • Returns agent-friendly structured output            │
└─────────────────────────────────────────────────────────┘
                          │
                    MCP Protocol
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   AI Agent (Claude Code)                 │
│  • Uses MCP tools natively                              │
│  • "Click #login and show resulting network calls"     │
│  • Gets: correlated action + request bundle            │
└─────────────────────────────────────────────────────────┘
```

**Pros**: Full control, no user setup, works headless
**Cons**: Separate browser instance, auth not preserved

### Option C: Hybrid (Best of Both)

Extension connects to MCP server, bridging user's browser to agent tools:

```
User's Chrome + Extension  ←→  Bridge Process  ←→  MCP Server  ←→  Claude Code
```

---

## Core Features

### 1. Request Capture with Action Correlation

```typescript
interface CapturedRequest {
  id: string;
  timestamp: number;

  // Request details
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;

  // Response details
  status: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;

  // Correlation (THE KEY DIFFERENTIATOR)
  initiator: {
    type: 'parser' | 'script' | 'redirect' | 'user_action';
    stack?: string[];           // JS call stack
    actionId?: string;          // Links to user action
    actionDescription?: string; // "Click on #login-button"
  };

  // Timing
  timing: {
    started: number;
    ttfb: number;      // Time to first byte
    completed: number;
  };
}
```

### 2. Action Tracking

```typescript
interface TrackedAction {
  id: string;
  type: 'click' | 'navigate' | 'submit' | 'type' | 'scroll';
  target: string;        // CSS selector or URL
  timestamp: number;
  resultingRequests: string[];  // Request IDs triggered by this action
}
```

### 3. Agent-Friendly Output Format

```
════════════════════════════════════════════════════════════
ACTION: Click on button#submit-login
TIME: 2024-01-15T10:30:45.123Z
════════════════════════════════════════════════════════════

TRIGGERED REQUESTS (3):

[1] POST https://api.example.com/auth/login
    Status: 200 OK (245ms)

    Request Headers:
      Content-Type: application/json
      X-CSRF-Token: abc123...

    Request Body:
      {"email": "user@example.com", "password": "***"}

    Response Body:
      {"token": "eyJhbG...", "user": {"id": 123, "name": "John"}}

[2] GET https://api.example.com/user/profile
    Status: 200 OK (89ms)
    Triggered by: Response from request [1]

    Response Body:
      {"preferences": {...}, "settings": {...}}

[3] GET https://cdn.example.com/avatar/123.jpg
    Status: 200 OK (156ms)
    Type: Image (not shown)

════════════════════════════════════════════════════════════
```

### 4. MCP Tools (for Option B)

```yaml
tools:
  - name: browser_navigate
    description: Navigate to a URL and capture resulting network traffic
    parameters:
      url: string
    returns: NavigationResult with all network requests

  - name: browser_click
    description: Click an element and capture triggered network requests
    parameters:
      selector: string (CSS selector)
      wait_for_network?: boolean (wait for requests to complete)
    returns: ClickResult with correlated requests

  - name: browser_get_network
    description: Get captured network requests with optional filtering
    parameters:
      since_action?: string (action ID)
      url_pattern?: string (regex)
      method?: string
      status_range?: [number, number]
    returns: Array of CapturedRequest

  - name: browser_explain_request
    description: Get detailed explanation of a specific request
    parameters:
      request_id: string
    returns: Full request details with initiator chain

  - name: browser_replay_request
    description: Replay a captured request (useful for testing)
    parameters:
      request_id: string
      modifications?: object (header/body overrides)
    returns: New response
```

---

## Implementation Phases

### Phase 1: Enhanced Extension (2-3 days)

Upgrade current Network Copier to add:

1. **Action tracking**: Inject content script that monitors clicks, navigations, form submits
2. **Request correlation**: Match requests to actions via timing + initiator
3. **Better output format**: Include correlation data in copied text
4. **Local WebSocket bridge**: Optional localhost server for agent access

Deliverable: Extension that can be used via copy/paste OR programmatic access

### Phase 2: MCP Server (3-4 days)

Build standalone MCP server:

1. **Browser management**: Launch/connect to Chrome via Puppeteer
2. **CDP integration**: Full Network domain access
3. **Action→Request tracking**: Automatic correlation
4. **MCP tools**: navigate, click, type, get_network, explain_request
5. **Agent-friendly formatting**: Structured output optimized for LLM consumption

Deliverable: `npx @0pfleet/network-intelligence-mcp`

### Phase 3: Hybrid Bridge (2 days)

Connect extension to MCP:

1. **Native Messaging host**: Bridge between extension and MCP server
2. **Bidirectional**: Agent can query extension's captured data
3. **Session preservation**: Use existing auth from user's browser

Deliverable: Single solution that works both ways

### Phase 4: Publishing (1-2 days)

1. **MCP Registry**: Register server at registry.modelcontextprotocol.io
2. **Chrome Web Store**: Publish polished extension
3. **SKILL.md**: Create skill for Claude Code with usage guidance
4. **GitHub**: Proper documentation, examples, demos

---

## Skill Definition (SKILL.md)

```markdown
---
name: network-intelligence
description: Understand network requests triggered by browser actions
version: 1.0.0
author: 0pfleet
tools:
  - network-intelligence-mcp
---

# Network Intelligence Skill

Use this skill when you need to:
- Understand what API calls a website makes
- Debug failing network requests
- Reverse-engineer undocumented APIs
- Correlate user actions with resulting network traffic

## Usage

### With MCP Server (managed browser)
The MCP server gives you tools to navigate, click, and capture network traffic.

### With Extension (user's browser)
Connect to ws://localhost:9876 to receive network data from the user's active browser.

## Example Workflow

1. User: "What API does Twitter use when I like a tweet?"
2. Agent: Navigate to tweet, click like button, capture network
3. Output: POST https://api.twitter.com/graphql with mutation details
```

---

## Competitive Differentiation

| Feature | Chrome DevTools MCP | Browser MCP | Network Intelligence |
|---------|---------------------|-------------|---------------------|
| Network capture | ✓ | ✗ | ✓ |
| Action correlation | ✗ | ✗ | ✓ (KEY) |
| User's browser | ✗ | ✓ | ✓ |
| Managed browser | ✓ | ✗ | ✓ |
| Agent-friendly format | Partial | ✗ | ✓ |
| Request replay | ✗ | ✗ | ✓ |
| MCP + Extension hybrid | ✗ | ✓ | ✓ |

**Our differentiator**: Action→Network correlation with agent-optimized output

---

## Open Questions

1. **Sensitive data handling**: How to redact auth tokens, passwords in output?
2. **Large responses**: Truncation strategy? Streaming?
3. **WebSocket traffic**: Include or separate tool?
4. **Service Workers**: How to capture SW-intercepted requests?
5. **Cross-origin iframes**: Capture or ignore?

---

## Next Steps

1. [ ] Decide: Start with Extension enhancement or MCP server?
2. [ ] Design: Finalize output format with real-world examples
3. [ ] Build: Phase 1 implementation
4. [ ] Test: Use it ourselves for a week
5. [ ] Iterate: Based on real usage patterns
6. [ ] Publish: When genuinely useful

---

## Resources

- CDP Network Domain: https://chromedevtools.github.io/devtools-protocol/tot/Network/
- MCP Registry: https://registry.modelcontextprotocol.io/
- Chrome Extensions: https://developer.chrome.com/docs/extensions/
- Existing inspiration: Browser MCP, Chrome DevTools MCP
