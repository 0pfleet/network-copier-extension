# Publishing to Chrome Web Store

Notes for when ready to publish publicly.

## Requirements

- **$5 one-time fee** — Chrome Web Store developer account
- **Privacy policy** — Required for all extensions. Can host on GitHub Pages. Ours is simple: "No data collected, all processing happens locally in your browser."
- **Store listing assets**:
  - Title (max 45 chars): `Network Copier - Agent-Friendly Traffic Export`
  - Short description (max 132 chars)
  - Detailed description
  - Icon: 128x128 PNG (need a proper designed one, not generated)
  - Screenshots: 1280x800 or 640x400
  - Category: Developer Tools
- **Permission justification** — Must explain why we need `devtools` permission

## Publishing Process

1. Create zip of extension files (exclude `.git`, `.md` files)
2. Go to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. Register as developer, pay $5, verify identity
4. Create new item → upload zip
5. Fill out store listing, upload screenshots
6. Submit for review (typically 1-3 business days)

## Making it Professional

- [ ] Design proper icon (current ones are placeholder squares)
- [ ] Create privacy policy page (GitHub Pages or similar)
- [ ] Take screenshots showing extension in action
- [ ] Optional: short demo video/GIF
- [ ] Add LICENSE file (MIT?)
- [ ] Polish README with badges, usage examples

## Store Listing Draft

**Title:** Network Copier - Agent-Friendly Traffic Export

**Short description:**
Capture network requests and copy them as clean, structured text. Perfect for sharing with AI assistants.

**Detailed description:**
```
Network Copier adds a new panel to Chrome DevTools that captures all network traffic and lets you export it in a clean, agent-friendly text format.

Perfect for:
• Debugging APIs with AI assistants (Claude, ChatGPT, etc.)
• Sharing network context without messy HAR files
• Quick copy/paste of request/response pairs
• Security auditing and documentation

Features:
• Real-time capture of all network requests
• Filter by URL or type (XHR, Fetch, JS, CSS, Images)
• Toggle what to include: headers, request body, response body
• Truncation control for large payloads
• Auto-pretty-print JSON responses
• Select individual requests or copy all
• One-click copy to clipboard

Privacy: All processing happens locally in your browser. No data is collected or transmitted.
```

---

# Why This Extension is Useful

## The Problem

| Pain Point | Current Solutions | Why They Fall Short |
|------------|-------------------|---------------------|
| Sharing API failures with AI | Screenshot or manual copy | Loses details, not parseable |
| HAR export | Built-in Chrome feature | Verbose JSON, overwhelming to paste |
| Explaining network behavior | Describe it manually | Error-prone, time-consuming |
| Bulk request analysis | Copy one at a time | Tedious |

## Use Cases

1. **API Debugging** — "Here's the failing request" → paste → instant AI analysis
2. **Understanding APIs** — Capture a few calls, paste, ask "how does this API work?"
3. **Performance issues** — Share timing + headers + response size
4. **Security auditing** — Document requests for pentest reports
5. **Learning** — Inspect how sites communicate with backends

## Competition Analysis

| Extension | What it does | Gap |
|-----------|--------------|-----|
| HAR Export Trigger | Exports HAR JSON | Not agent-friendly, raw JSON |
| Copy All URLs | Copies just URLs | No headers/bodies |
| Network+ | Enhanced network panel | No export feature |

**Our differentiator:** Optimized specifically for copy/paste to AI agents. Clean text format, configurable detail level, bulk selection.

## Validation Ideas

Before investing in polish/publishing:
- [ ] Use it myself for a week — does it actually help?
- [ ] Share with a few people, get feedback
- [ ] Track: how often do I reach for it vs. manual copy?
- [ ] What's missing? What's annoying?

---

*Review this after proving usability. If it's genuinely useful, invest in proper branding and publish.*
