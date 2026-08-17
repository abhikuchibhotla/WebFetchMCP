# Research Context MCP

An MCP server for local models in Claude Code or Codex. It searches normal public search-result pages, reads relevant public pages as clean text, and gives that temporary context to the model.

It uses **no search APIs, API keys, databases, disk cache, or memory cache**. The only retained data is the current tool call in process memory; it is discarded when that call finishes.

## How it avoids CAPTCHA loops

The default search order is DuckDuckGo HTML, Bing HTML, then Google HTML. Each site is tried once only. If one shows a CAPTCHA, JavaScript-only page, rate limit, or other block, the server moves to the next site. It never retries a blocked site.

If all sites fail, the tool returns a `needs_research_handoff` response. Claude Code or Codex should then ask you to either:

1. provide one to five public source URLs, or
2. use an online-enabled model to research the topic and paste its source URLs.

The model can call `read_urls` to read and understand those links. The server itself never contacts an online model.

## Tools

- `web_search` — searches normal result pages and returns ranked links/snippets.
- `docs_search` — searches for a library’s likely official documentation.
- `web_fetch` — reads one public HTML or text URL.
- `read_urls` — reads one to five supplied URLs sequentially.
- `search_and_read` — searches and reads the highest-ranked sources sequentially.

Fetched text is marked as untrusted reference material so the harness should treat page instructions as data, not commands.

## Install

Requires Node.js 20 or newer.

```sh
npm install
npm run build
```

### Claude Code

Install it under the name `research-context-mcp`:

```sh
claude mcp add research-context-mcp --scope user -- node /Users/abhishekkuchibhotla/Projects/searchMCP/dist/index.js
```

### Codex

Add this to your Codex MCP configuration:

```toml
[mcp_servers.research_context]
command = "node"
args = ["/Users/abhishekkuchibhotla/Projects/searchMCP/dist/index.js"]
```

Restart the harness after changing its MCP configuration.

## Configuration

The default ordered search sites are already suitable for light use:

```sh
SEARCH_SITES=duckduckgo-html,bing-html,google-html
```

You can omit a source or change the order. These values are site-page readers, not APIs:

```sh
SEARCH_SITES=duckduckgo-html,bing-html
```

The optional limits below are conservative for laptops and a DGX Spark:

```sh
MAX_PAGE_CHARS=15000
FETCH_TIMEOUT_MS=15000
WEB_ALLOWLIST=docs.python.org,react.dev
WEB_BLOCKLIST=example.com
```

## Safety and resource limits

- Public HTTP/HTTPS pages only; private networks, localhost, URL credentials, and nonstandard ports are blocked.
- Every redirect is checked against the same policy.
- Search pages are capped at 1 MB; fetched pages at 2 MB, 15 seconds, and 15,000 returned characters by default.
- `read_urls` and `search_and_read` fetch pages one at a time, keeping peak memory low.
- HTML and plain-text pages are supported. JavaScript-rendered sites and PDFs are intentionally skipped.

## Development checks

```sh
npm run check
npm run build
```
