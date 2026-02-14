# Network Intelligence MCP Server

## Project Overview

This repo contains a Chrome DevTools extension ("Network Copier") and an MCP server
that gives AI agents network-level understanding of browser traffic.

The MCP server is the primary deliverable — it launches a browser, captures all network
traffic via CDP, and correlates user actions (clicks, navigations) to the requests they trigger.

## Development

```bash
cd mcp-server
npm install
npm run build      # Compile TypeScript
npm test           # Run 83 unit tests
npx vitest run tests/integration.test.ts  # Run integration tests (launches real browser)
npm run lint       # Type-check only
```

## MCP Server Usage

The server is configured in `~/.claude/mcp.json`. See `SKILL.md` for full usage guide
and example workflows.

Available tools: `browser_navigate`, `browser_click`, `browser_type`,
`get_network_log`, `get_request_detail`, `clear_capture`.

## Architecture

- `src/network.ts` — CDP Network domain event processing, ring buffer storage
- `src/correlator.ts` — 4-layer action-to-request correlation engine
- `src/formatter.ts` — Agent-friendly output formatting with sensitive data redaction
- `src/browser.ts` — Puppeteer browser management and orchestration
- `src/index.ts` — MCP server entry point with tool definitions
- `src/types.ts` — TypeScript type system

## Testing

- Unit tests: `tests/network.test.ts`, `tests/correlator.test.ts`, `tests/formatter.test.ts`
- Integration tests: `tests/integration.test.ts` (requires Chromium, launches real browser)
- Fixtures: `tests/fixtures/cdp-events.ts`
