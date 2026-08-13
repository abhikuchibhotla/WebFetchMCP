# Google Context MCP

A free, stateless MCP server for local-model harnesses such as Codex and Claude Code. It can search the web, follow a relevant public link, extract readable page text, and return it as temporary tool context.

It does **not** cache search results, write web pages to disk, use a database, or retain a browsing history. It holds only the current tool call’s results in memory, then releases them. Search providers and pages you visit will still receive the corresponding network request, as they normally would.

## What it exposes

- `search_web` — ranked titles, links, and snippets from the configured search provider.
- `read_webpage` — cleaned text from one public HTML or plain-text page.
- `search_and_read` — searches and reads the top ranked pages in one call.

Fetched text is explicitly labelled as untrusted reference material so an agent should treat page instructions as content, not commands.

## Setup

1. Install dependencies and compile:

   ```sh
   npm install
   npm run build
   ```

2. Choose a search provider. Copy `.env.example` to a private environment file if helpful, but do not commit it.

   ### Free default: DuckDuckGo HTML results

   No account or key is needed:

   ```sh
   SEARCH_PROVIDER=duckduckgo-html
   ```

   This is the default. It needs no account, key, database, cache, or paid service. It is a web search provider, not Google.

   ### Google results

   Google has no reliable, official free web-search API available to new users. The server includes an experimental no-key `SEARCH_PROVIDER=google-html` mode, but Google commonly returns a JavaScript-only page or a CAPTCHA to automated clients, so it cannot be recommended for dependable use. The key-backed alternatives below are the reliable choices if you strictly need Google’s ranking.

   ### Optional: Serper (Google results)

   Serper is a Google-results API. Add:

   ```sh
   SEARCH_PROVIDER=serper
   SERPER_API_KEY=your_key
   ```

   ### Legacy: Google Programmable Search JSON API

   ```sh
   SEARCH_PROVIDER=google-cse
   GOOGLE_API_KEY=your_key
   GOOGLE_CSE_ID=your_search_engine_id
   ```

   Google’s Programmable Search JSON API is closed to new customers and Google says existing customers must transition by January 1, 2027. Use it only if you already have access. See Google’s [official API overview](https://developers.google.com/custom-search/v1/overview).

3. Add it to your harness configuration. Keep secrets in the harness environment, not in this repository.

## Codex configuration

Put this in `~/.codex/config.toml` (adjust the absolute path if you move this project):

```toml
[mcp_servers.google_context]
command = "node"
args = ["/Users/abhishekkuchibhotla/Projects/searchMCP/dist/index.js"]
```

Restart Codex after editing the configuration.

## Claude Code configuration

From this project directory:

```sh
claude mcp add google-context --scope user \
  -- node /Users/abhishekkuchibhotla/Projects/searchMCP/dist/index.js
```

Use the equivalent `-e GOOGLE_API_KEY=... -e GOOGLE_CSE_ID=...` variables if you are an existing Google CSE customer.

## Safety limits

- Only public `http` and `https` pages are fetched.
- Localhost, private network ranges, credentials in URLs, and nonstandard ports are blocked. Redirect targets are checked too.
- `WEB_ALLOWLIST` and `WEB_BLOCKLIST` can further restrict fetches, for example `WEB_ALLOWLIST=docs.python.org,*.wikipedia.org`.
- Individual page responses are limited to 2 MB, 15 seconds, and 15,000 returned characters by default. `search_and_read` fetches pages one at a time to keep peak memory low. Set `MAX_PAGE_CHARS` or `FETCH_TIMEOUT_MS` to tune within the documented bounds.
- HTML and plain-text pages are supported. JavaScript-rendered sites and PDFs are intentionally not fetched as local files.

## Development

```sh
npm run dev
npm run check
```

The server uses stdio. It writes only operational logs to stderr, leaving stdout exclusively for the MCP protocol.
