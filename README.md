# WebFetchMCP

WebFetchMCP is a lightweight plugin (an MCP server) that gives local AI models and coding assistants the ability to **search the web and read documentation**.

Instead of your AI saying *"I don't have access to the internet,"* it can now search DuckDuckGo, fetch the official documentation you ask for, and read it to write better code for you.

## Quickstart: Try It Out Now

If you have downloaded this code to your computer, you can install and use it in less than 30 seconds.

**1. Build the tool:**
Open your terminal in this folder and run:
```sh
npm install
npm run build
npm link
```
*(This installs the tool globally on your computer so your AI can find it).*

**2. Attach it to your AI (Claude Code Example):**
```sh
claude mcp add webfetch-mcp --scope user -- webfetch-mcp
```

**3. Test it out!**
Open Claude Code (or your chosen AI harness) and ask it:
> *"Can you search the web for 'Node.js MCP tutorial' and summarize the top 3 results?"*
or
> *"Can you fetch this URL and tell me what the latest syntax is? https://react.dev/reference/react/useEffect"*

---

## How It Works

This tool was built specifically for **Local AI Models** (like Qwen, Llama, etc.). Because local models have smaller memory windows (context limits) than massive cloud models, standard web scrapers often crash them by feeding them thousands of lines of useless HTML menus and footers.

**WebFetchMCP solves this by:**
1. **Fetching the page:** It grabs the raw website data.
2. **Stripping the junk:** It throws away navigation bars, footers, sidebars, and ads.
3. **Preserving the code:** It explicitly protects `<pre>` and `<code>` blocks so you don't lose formatting.
4. **Converting to Markdown:** It turns the remaining text into lightweight Markdown and hands it to the AI.

It is **100% Stateless**. It does not download junk files to your SSD, and it uses a smart 15-minute in-memory cache so if your AI asks for the exact same page twice, it loads instantly without re-downloading it.

---

## What can the AI do with this?

When you connect WebFetchMCP, your AI gets three new invisible tools:
- `web_search`: The AI can Google/DuckDuckGo things on its own.
- `web_fetch`: If you paste a URL in the chat, the AI can read it.
- `docs_search`: The AI can search for specific library docs (e.g., searching specifically inside `react.dev`).

---

## Installing on Another Machine

If you host this repository privately on GitHub and want to install it on a second computer (like a VPS or remote laptop), you don't even need to clone it. Just run this command on the new machine:

```sh
# Replace 'your-username' with your actual GitHub username
npm install -g git+ssh://git@github.com/your-username/webfetch-mcp.git
```
Then attach it to Claude Code as normal:
```sh
claude mcp add webfetch-mcp --scope user -- webfetch-mcp
```
