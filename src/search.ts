import { config } from "./config.js";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: "google" | "duckduckgo";
};

export type SearchRequest = {
  query: string;
  maxResults: number;
  country?: string;
  language?: string;
};

type SerperResponse = {
  organic?: Array<{ title?: string; link?: string; snippet?: string }>;
};

type GoogleCseResponse = {
  items?: Array<{ title?: string; link?: string; snippet?: string }>;
};

function googleResultUrl(href: string): string | undefined {
  try {
    const candidate = href.startsWith("/")
      ? new URL(href, "https://www.google.com")
      : new URL(href);
    const redirected = candidate.hostname.endsWith("google.com") && candidate.pathname === "/url"
      ? candidate.searchParams.get("q")
      : candidate.toString();
    if (!redirected) return undefined;
    const url = new URL(redirected);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.hostname.endsWith("google.com")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseGoogleHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  $("a").each((_, anchor) => {
    if (results.length >= 10) return false;
    const title = $(anchor).find("h3").first().text().trim();
    const url = googleResultUrl($(anchor).attr("href") ?? "");
    if (!title || !url || seen.has(url)) return;

    // Google changes its DOM frequently. The surrounding result block is the
    // least brittle source for a useful fallback snippet.
    const surroundingText = $(anchor).parent().parent().text().replace(/\s+/g, " ").trim();
    const snippet = surroundingText.startsWith(title)
      ? surroundingText.slice(title.length).trim().slice(0, 800)
      : surroundingText.slice(0, 800);
    seen.add(url);
    results.push({ title, url, snippet, source: "google" });
  });
  return results;
}

function duckDuckGoResultUrl(href: string): string | undefined {
  try {
    const candidate = new URL(href, "https://html.duckduckgo.com");
    const isDuckDuckGo = candidate.hostname === "duckduckgo.com" || candidate.hostname.endsWith(".duckduckgo.com");
    const redirected = isDuckDuckGo
      ? candidate.searchParams.get("uddg") ?? candidate.searchParams.get("u")
      : candidate.toString();
    if (!redirected) return undefined;
    const url = new URL(redirected);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const addResult = (anchor: Element, snippetElement?: cheerio.Cheerio<Element>) => {
    if (results.length >= 10) return;
    const link = $(anchor);
    const title = link.text().replace(/\s+/g, " ").trim();
    const url = duckDuckGoResultUrl(link.attr("href") ?? "");
    if (!title || !url || seen.has(url)) return;
    const snippet = (snippetElement?.text() ?? link.parent().parent().text()).replace(/\s+/g, " ").trim().slice(0, 800);
    seen.add(url);
    results.push({ title, url, snippet, source: "duckduckgo" });
  };

  $(".result").each((_, result) => {
    const link = $(result).find("a.result__a").first().get(0);
    if (link) addResult(link, $(result).find(".result__snippet").first());
  });
  // DuckDuckGo Lite has a different, table-based result layout.
  $("a.result-link").each((_, link) => addResult(link));
  return results;
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not configured. Set it in the MCP server environment and restart the server.`);
  }
  return value;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Search provider returned ${response.status}: ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

function normalise(items: Array<{ title?: string; link?: string; snippet?: string }> | undefined): SearchResult[] {
  return (items ?? [])
    .filter((item): item is Required<Pick<typeof item, "link">> & typeof item => Boolean(item.link))
    .map((item) => ({
      title: item.title?.trim() || item.link,
      url: item.link,
      snippet: item.snippet?.trim() || "",
      source: "google" as const
    }));
}

async function searchSerper(request: SearchRequest): Promise<SearchResult[]> {
  const key = requireEnv("SERPER_API_KEY", config.serperApiKey);
  const payload: Record<string, string | number> = {
    q: request.query,
    num: request.maxResults
  };
  if (request.country) payload.gl = request.country;
  if (request.language) payload.hl = request.language;

  const data = await requestJson<SerperResponse>("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return normalise(data.organic);
}

async function searchGoogleHtml(request: SearchRequest): Promise<SearchResult[]> {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", request.query);
  url.searchParams.set("num", String(request.maxResults));
  url.searchParams.set("gbv", "1");
  if (request.country) url.searchParams.set("gl", request.country);
  if (request.language) url.searchParams.set("hl", request.language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": request.language ? `${request.language},en;q=0.8` : "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (compatible; GoogleContextMCP/0.1; +https://github.com/your-org/google-context-mcp)"
      }
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Google search timed out.");
    throw new Error(`Unable to contact Google: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Google returned HTTP ${response.status}.`);

  const html = await response.text();
  if (/unusual traffic|recaptcha|our systems have detected/i.test(html)) {
    throw new Error("Google rate-limited this server or requested a CAPTCHA. Wait and retry, or configure a supported API provider.");
  }
  const results = parseGoogleHtml(html).slice(0, request.maxResults);
  if (results.length === 0) throw new Error("Google returned no parseable web results. Its page format may have changed or the request was restricted.");
  return results;
}

async function searchDuckDuckGoHtml(request: SearchRequest): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", request.query);
  if (request.country) url.searchParams.set("kl", `${request.country.toLowerCase()}-en`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": request.language ? `${request.language},en;q=0.8` : "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (compatible; ContextMCP/0.1)"
      }
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Web search timed out.");
    throw new Error(`Unable to contact the free search provider: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Free search provider returned HTTP ${response.status}.`);
  const results = parseDuckDuckGoHtml(await response.text()).slice(0, request.maxResults);
  if (results.length === 0) throw new Error("The free search provider returned no parseable web results. Retry later or configure another provider.");
  return results;
}

async function searchGoogleCse(request: SearchRequest): Promise<SearchResult[]> {
  const key = requireEnv("GOOGLE_API_KEY", config.googleApiKey);
  const cx = requireEnv("GOOGLE_CSE_ID", config.googleCseId);
  const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", request.query);
  url.searchParams.set("num", String(request.maxResults));
  if (request.country) url.searchParams.set("gl", request.country);
  if (request.language) url.searchParams.set("lr", `lang_${request.language}`);

  const data = await requestJson<GoogleCseResponse>(url.toString(), {});
  return normalise(data.items);
}

export async function searchGoogle(request: SearchRequest): Promise<SearchResult[]> {
  switch (config.provider) {
    case "duckduckgo-html":
      return searchDuckDuckGoHtml(request);
    case "google-html":
      return searchGoogleHtml(request);
    case "serper":
      return searchSerper(request);
    case "google-cse":
      return searchGoogleCse(request);
    default:
      throw new Error(`Unknown SEARCH_PROVIDER '${config.provider}'. Use 'duckduckgo-html', 'google-html', 'serper', or 'google-cse'.`);
  }
}

export type DocsSearchRequest = SearchRequest & { library: string };

const KNOWN_DOCS_DOMAINS: Record<string, string> = {
  python: "site:docs.python.org OR site:pypi.org",
  rust: "site:docs.rs OR site:doc.rust-lang.org",
  react: "site:react.dev OR site:npmjs.com",
  node: "site:nodejs.org/docs OR site:npmjs.com",
  go: "site:pkg.go.dev",
  javascript: "site:developer.mozilla.org",
  typescript: "site:typescriptlang.org/docs",
  java: "site:docs.oracle.com",
  spring: "site:docs.spring.io",
  aws: "site:docs.aws.amazon.com",
  azure: "site:learn.microsoft.com",
  gcp: "site:cloud.google.com/docs"
};

export async function searchDocs(request: DocsSearchRequest): Promise<SearchResult[]> {
  const lib = request.library.toLowerCase().trim();
  const filter = KNOWN_DOCS_DOMAINS[lib] || `site:${lib}.com OR site:${lib}.org OR site:${lib}.io OR site:${lib}.dev`;
  const docsQuery = `${request.query} ${filter}`;
  
  const modifiedRequest: SearchRequest = {
    ...request,
    query: docsQuery
  };
  
  return searchGoogle(modifiedRequest);
}
