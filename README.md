# WebFetchMCP

WebFetchMCP is a lightweight, harness-agnostic Model Context Protocol (MCP) server designed specifically for coding agents and local LLMs. It empowers models (like Qwen Coder, Llama, Claude, etc.) to search the web for documentation, forums, and technical articles without requiring native web-search support in the host application.

It prioritizes **token efficiency** and **code preservation**. It does **not** crawl recursively, write cached HTML to disk, or fill your machine with vector databases. It is a stateless bridge designed to pull in web context cleanly and efficiently.

## Core Features

- **Harness-Agnostic**: Works with any standard MCP client (Claude Code, OpenCode, Cline, Goose, etc.).
- **Token-Efficient**: Uses `turndown` and code-density heuristics to strip navigation, footers, and noise, converting HTML into clean GitHub Flavored Markdown (GFM).
- **Code Preservation**: Explicitly preserves `<code>` and `<pre>` tags so technical signatures and code snippets survive the transition to Markdown.
- **In-Memory Caching**: Uses a short-lived LRU cache (15 min) to prevent redundant network fetches if an agent queries the same URL multiple times during a coding session.
- **Documentation Scoping**: Includes a specialized `docs_search` tool that automatically targets official documentation domains (e.g., searching `library="react"` scopes to `react.dev`).

## Tools Exposed

- `web_search(query, ...)`: Returns ranked titles, links, and snippets from the configured search provider.
- `docs_search(query, library, ...)`: Similar to `web_search`, but appends domain scoping filters (e.g., `site:docs.python.org`) based on the requested library ecosystem.
- `web_fetch(url, ...)`: Fetches a single public webpage, strips the bloat, and returns token-efficient Markdown.

## Setup

1. Install dependencies and compile:

   ```sh
   npm install
   npm run build
   ```

2. Configure a Search Provider (Default is DuckDuckGo HTML). 
   Set the provider via the `SEARCH_PROVIDER` environment variable (e.g., `duckduckgo-html`, `serper`, `google-cse`).

3. Add it to your harness configuration. 

   **Example: Claude Code configuration**
   ```sh
   claude mcp add webfetch-mcp --scope user \
     -- node /absolute/path/to/searchMCP/dist/index.js
   ```

## Architecture & Safety Limits

- Fetched text is explicitly labelled as untrusted reference material.
- Only public `http` and `https` pages are fetched (local/private IPs are blocked).
- `WEB_ALLOWLIST` and `WEB_BLOCKLIST` can restrict domains.
- Responses are capped at 2MB raw size and the returned Markdown is truncated to prevent overflowing local LLM context windows.

## Development

```sh
npm run dev
npm run check
npm run build
```
