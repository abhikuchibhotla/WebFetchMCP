import { lookup } from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { LRUCache } from "lru-cache";
import { config } from "./config.js";

const pageCache = new LRUCache<string, WebPage>({
  max: 50,
  ttl: 1000 * 60 * 15, // 15 minutes
});

export type WebPage = {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  contentType: string;
};

const LOCAL_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".home", ".lan"];
const REMOVE_SELECTORS = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "form",
  "nav", "header", "footer", "aside", "dialog", "[role=banner]", "[role=navigation]",
  "[role=contentinfo]", ".cookie", ".cookies", "#cookie", "#cookies", ".advert", ".ads", ".advertisement"
].join(",");

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.") || value.startsWith("::ffff:192.168.") || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(value);
  }
  return true;
}

function hostMatches(pattern: string, host: string): boolean {
  const candidate = host.toLowerCase();
  return pattern.startsWith("*.")
    ? candidate.endsWith(pattern.slice(1))
    : candidate === pattern;
}

function assertHostPolicy(hostname: string): void {
  if (config.blocklist.some((pattern) => hostMatches(pattern, hostname))) {
    throw new Error(`Fetching '${hostname}' is blocked by WEB_BLOCKLIST.`);
  }
  if (config.allowlist.length > 0 && !config.allowlist.some((pattern) => hostMatches(pattern, hostname))) {
    throw new Error(`Fetching '${hostname}' is not allowed by WEB_ALLOWLIST.`);
  }
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https URLs can be read.");
  }
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Only ports 80 and 443 are allowed.");

  const hostname = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("Local and private-network hosts cannot be read.");
  }
  assertHostPolicy(hostname);

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Private-network IP addresses cannot be read.");
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("The URL resolves to a local or private-network address.");
  }
  return url;
}

async function bodyWithLimit(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > config.maxResponseBytes) throw new Error("The page is larger than the 2 MB response limit.");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.maxResponseBytes) {
        await reader.cancel();
        throw new Error("The page exceeded the 2 MB response limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function cleanWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function extractPage(rawHtml: string, url: string): { title: string; text: string } {
  const $ = cheerio.load(rawHtml);
  $(REMOVE_SELECTORS).remove();
  $("[hidden], [aria-hidden=true]").remove();

  // Basic code density cleaning: remove dense link lists
  $("ul, ol").each((_, list) => {
    const textLen = $(list).text().trim().length;
    if (textLen === 0) return;
    const links = $(list).find("a");
    if (links.length > 5) {
      const linkTextLen = links.text().trim().length;
      if (linkTextLen / textLen > 0.8) {
        $(list).remove();
      }
    }
  });

  const root = $("article, main, [role=main]").first();
  const contentRoot = root.length ? root : $("body");
  
  const title = cleanWhitespace($("title").first().text()) || new URL(url).hostname;
  
  // Convert to Markdown
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
  });
  
  // Try to preserve pre/code better
  turndownService.keep(['pre', 'code']);

  let text = turndownService.turndown(contentRoot.html() || "");
  text = cleanWhitespace(text);

  return { title, text };
}

export async function readWebPage(rawUrl: string, maxCharacters = config.maxPageChars): Promise<WebPage> {
  let url = await validatePublicUrl(rawUrl);
  
  const cached = pageCache.get(url.toString());
  if (cached) {
    return { ...cached, text: cached.text.slice(0, maxCharacters), truncated: cached.text.length > maxCharacters };
  }

  let response: Response | undefined;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "user-agent": "google-context-mcp/0.1 (+https://github.com/your-org/google-context-mcp)"
        }
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "The page fetch timed out." : `Unable to fetch page: ${String(error)}`;
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The page returned a redirect without a Location header.");
      url = await validatePublicUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }

  if (!response) throw new Error("Unable to fetch page.");
  if (response.status >= 300 && response.status < 400) throw new Error("The page exceeded the redirect limit.");
  if (!response.ok) throw new Error(`The page returned HTTP ${response.status}.`);

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml") && !contentType.includes("text/plain")) {
    throw new Error(`Unsupported content type '${contentType || "unknown"}'. Only HTML and plain-text pages can be read.`);
  }

  const body = await bodyWithLimit(response);
  const extracted = contentType.includes("text/plain")
    ? { title: url.hostname, text: cleanWhitespace(body) }
    : extractPage(body, url.toString());
  if (!extracted.text) throw new Error("No readable text was found. The page may require JavaScript or restrict automated access.");

  const cappedText = extracted.text.slice(0, maxCharacters);
  
  const resultPage: WebPage = {
    url: url.toString(),
    title: extracted.title,
    text: extracted.text, // store full text in cache
    truncated: false,
    contentType
  };
  
  pageCache.set(url.toString(), resultPage);

  return {
    ...resultPage,
    text: cappedText,
    truncated: extracted.text.length > cappedText.length
  };
}
