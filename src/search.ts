import * as cheerio from "cheerio";
import { config } from "./config.js";

export type SearchResult = { title: string; url: string; snippet: string; source: string };
export type SearchRequest = { query: string; maxResults: number; country?: string; language?: string };
export type DocsSearchRequest = SearchRequest & { library: string };
export type SearchAttempt = { site: string; outcome: "success" | "captcha_or_blocked" | "failed"; detail?: string };
export type SearchResponse = { site: string; results: SearchResult[]; attempts: SearchAttempt[] };

export class SearchUnavailableError extends Error {
  constructor(public readonly attempts: SearchAttempt[]) { super("No search-result page returned usable links."); }
}

function clean(value: string): string { return value.replace(/\s+/g, " ").trim(); }

function publicUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch { return undefined; }
}

async function fetchSearchPage(url: URL, language?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": language ? `${language},en;q=0.8` : "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (compatible; ResearchContextMCP/0.2)"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 1_000_000) throw new Error("Search page exceeds the 1 MB limit.");
    return await response.text();
  } finally { clearTimeout(timer); }
}

function addResult(results: SearchResult[], seen: Set<string>, title: string, rawUrl: string, snippet: string, source: string, maximum: number): void {
  const url = publicUrl(rawUrl);
  if (!url || !title || seen.has(url) || results.length >= maximum) return;
  seen.add(url);
  results.push({ title: clean(title), url, snippet: clean(snippet).slice(0, 800), source });
}

function parseDuckDuckGo(html: string, maximum: number): SearchResult[] {
  const $ = cheerio.load(html), results: SearchResult[] = [], seen = new Set<string>();
  $(".result a.result__a, a.result-link").each((_, element) => {
    const link = $(element);
    const href = link.attr("href") ?? "";
    let destination = href;
    try {
      const redirect = new URL(href, "https://html.duckduckgo.com");
      destination = redirect.hostname.endsWith("duckduckgo.com") ? (redirect.searchParams.get("uddg") ?? redirect.searchParams.get("u") ?? "") : redirect.toString();
    } catch { return; }
    const block = link.closest(".result");
    addResult(results, seen, link.text(), destination, block.find(".result__snippet").text() || block.text(), "duckduckgo", maximum);
  });
  return results;
}

function parseBing(html: string, maximum: number): SearchResult[] {
  const $ = cheerio.load(html), results: SearchResult[] = [], seen = new Set<string>();
  $("li.b_algo").each((_, element) => {
    const block = $(element), link = block.find("h2 a").first();
    addResult(results, seen, link.text(), link.attr("href") ?? "", block.find(".b_caption p").text() || block.text(), "bing", maximum);
  });
  return results;
}

function parseGoogle(html: string, maximum: number): SearchResult[] {
  const $ = cheerio.load(html), results: SearchResult[] = [], seen = new Set<string>();
  $("a").each((_, element) => {
    const link = $(element), title = link.find("h3").text();
    if (!title) return;
    let destination = "";
    try {
      const redirect = new URL(link.attr("href") ?? "", "https://www.google.com");
      destination = redirect.pathname === "/url" ? (redirect.searchParams.get("q") ?? "") : redirect.toString();
      if (new URL(destination).hostname.endsWith("google.com")) return;
    } catch { return; }
    addResult(results, seen, title, destination, link.parent().parent().text(), "google", maximum);
  });
  return results;
}

async function searchSite(site: string, request: SearchRequest): Promise<SearchResult[]> {
  const language = request.language?.toLowerCase();
  const country = request.country?.toLowerCase() ?? "us";
  if (site === "duckduckgo-html") {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", request.query);
    url.searchParams.set("kl", `${country}-${language ?? "en"}`);
    const html = await fetchSearchPage(url, language);
    if (/captcha|automated access|anomaly|unusual traffic/i.test(html)) throw new Error("CAPTCHA or automated-access block detected.");
    const results = parseDuckDuckGo(html, request.maxResults);
    if (results.length) return results;
    throw new Error("No parseable result links returned.");
  }
  if (site === "bing-html") {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(request.maxResults));
    url.searchParams.set("cc", country);
    const html = await fetchSearchPage(url, language);
    if (/captcha|automated access|unusual traffic/i.test(html)) throw new Error("CAPTCHA or automated-access block detected.");
    const results = parseBing(html, request.maxResults);
    if (results.length) return results;
    throw new Error("No parseable result links returned.");
  }
  if (site === "google-html") {
    const url = new URL("https://www.google.com/search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("num", String(request.maxResults));
    url.searchParams.set("gbv", "1");
    url.searchParams.set("gl", country);
    if (language) url.searchParams.set("hl", language);
    const html = await fetchSearchPage(url, language);
    if (/captcha|automated access|unusual traffic|enablejs/i.test(html)) throw new Error("CAPTCHA, automated-access block, or JavaScript-only page detected.");
    const results = parseGoogle(html, request.maxResults);
    if (results.length) return results;
    throw new Error("No parseable result links returned.");
  }
  throw new Error(`Unknown SEARCH_SITES entry '${site}'.`);
}

function outcome(error: unknown): SearchAttempt["outcome"] {
  return /captcha|rate.limit|unusual traffic|automated-access|HTTP 403|HTTP 429|JavaScript-only/i.test(error instanceof Error ? error.message : String(error)) ? "captcha_or_blocked" : "failed";
}

export async function searchWeb(request: SearchRequest): Promise<SearchResponse> {
  const attempts: SearchAttempt[] = [];
  for (const site of config.searchSites) {
    try {
      const results = await searchSite(site, request);
      attempts.push({ site, outcome: "success" });
      return { site, results, attempts };
    } catch (error) {
      attempts.push({ site, outcome: outcome(error), detail: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new SearchUnavailableError(attempts);
}

export async function searchDocs(request: DocsSearchRequest): Promise<SearchResponse> {
  const domains: Record<string, string> = { python: "docs.python.org", rust: "doc.rust-lang.org", react: "react.dev", node: "nodejs.org" };
  const domain = domains[request.library.toLowerCase()] ?? `${request.library}.dev`;
  return searchWeb({ ...request, query: `${request.query} site:${domain}` });
}
