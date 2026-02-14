# Network Intelligence Skill

Use this skill when you need to understand **what network requests a website makes** and **why**.

## When to Use

- "What API does this page call when I click Login?"
- "Why is this form submission failing?"
- "What authentication flow does this site use?"
- "Reverse-engineer the API behind this UI"
- "Debug why this page loads slowly — what requests are blocking?"
- "What happens when I type in this search box?"

## Setup

Already configured in `~/.claude/mcp.json`. Just restart Claude Code.

To see the browser window while debugging, set the environment variable:
```
NI_HEADLESS=false
```

## Available Tools

### `browser_navigate`
Navigate to a URL and see all resulting network traffic.

**Use when:** Starting a new investigation, loading a page for the first time.

```
Input: { url: "https://example.com/login" }
Output: All requests triggered by loading the page, correlated to the navigation action
```

### `browser_click`
Click an element and see what API calls it triggers.

**Use when:** You want to know what happens behind a button, link, or interactive element.

```
Input: { selector: "#login-btn" }
Input: { selector: "button.submit" }
Input: { selector: "[data-action='save']" }
```

**Tips for selectors:**
- Use `#id` for elements with IDs (most reliable)
- Use `button`, `a`, `input[type=submit]` for common elements
- Use `.class-name` for elements with CSS classes
- Use `[attribute=value]` for data attributes
- If unsure, ask the user: "What element should I click? Give me an ID, class, or describe it."

### `browser_type`
Type text into an input field. Captures any network requests triggered (autocomplete, validation, search).

```
Input: { selector: "input[name=email]", text: "user@example.com" }
Input: { selector: "#search", text: "network intelligence" }
```

### `get_network_log`
Query the captured network history with filters.

**Use when:** Looking for specific requests after browsing.

```
Input: { url_pattern: "/api/", method: "POST" }           # All API POST requests
Input: { status_min: 400 }                                  # All errors
Input: { resource_type: "fetch", limit: 10 }                # Recent fetch/XHR calls
Input: { url_pattern: "auth|login|token" }                  # Auth-related requests
```

**Filters available:**
- `url_pattern` — regex pattern to match URLs
- `method` — HTTP method (GET, POST, PUT, DELETE)
- `status_min` / `status_max` — status code range
- `resource_type` — xhr, fetch, document, stylesheet, script, image, font, websocket, other
- `limit` — max results (default: 50)

### `get_request_detail`
Get complete details of a specific request: headers, body, timing, stack trace, correlation.

**Use when:** You found an interesting request in the log and need the full picture.

```
Input: { request_id: "ABC123" }   # Use the ID from get_network_log results
```

### `clear_capture`
Reset everything for a fresh session.

## Example Workflows

### 1. "What API does this login page use?"

```
1. browser_navigate → https://example.com/login
2. browser_type → selector: "input[name=email]", text: "test@test.com"
3. browser_type → selector: "input[name=password]", text: "password123"
4. browser_click → selector: "button[type=submit]"
   → Shows: POST /api/auth/login with request/response bodies
5. get_network_log → url_pattern: "auth", method: "POST"
   → Shows the full auth flow with JWT tokens
```

### 2. "Why is this page slow?"

```
1. browser_navigate → https://slow-site.com
   → Shows all requests with timing data
2. get_network_log → status_min: 400
   → Shows any failed requests
3. get_request_detail → request_id from the slowest request
   → Shows full timing breakdown
```

### 3. "What happens when I click this button?"

```
1. browser_navigate → https://app.com/dashboard
2. browser_click → selector: "#export-btn"
   → Shows: GET /api/export → 200 with CSV data
   → Or: POST /api/jobs → 202 (async job created)
```

### 4. "Reverse-engineer this API"

```
1. browser_navigate → https://app.com
2. Click through the UI, each click shows API calls
3. get_network_log → resource_type: "fetch"
   → Full list of API endpoints used
4. get_request_detail on interesting requests
   → Headers, auth tokens, request/response schemas
```

## User Guidance

When the user asks you to investigate a website's network behavior:

1. **Ask for the URL** if not provided
2. **Navigate first** — always start with `browser_navigate`
3. **Ask what to interact with** — "Which button/form should I click?"
4. **Show results clearly** — the tool output is already formatted for you
5. **Dig deeper on interesting requests** — use `get_request_detail`

### Asking for Selectors

If the user wants you to click something but doesn't give a selector:

> "I can see the page. To click the right element, could you give me one of:
> - The button's text (e.g., 'Sign In')
> - An ID (e.g., '#login-btn')
> - A description (e.g., 'the blue submit button')
>
> Or I can try common selectors like `button[type=submit]` or `form button`."

### Sensitive Data

The tool automatically redacts:
- Passwords in request bodies (JSON and form-urlencoded)
- Authorization headers (shows first 15 chars only)
- Cookie values
- Tokens, SSNs, credit card numbers, API keys

You'll see `[REDACTED]` in the output where sensitive data was removed.
