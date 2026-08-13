import { config } from "./config.js";
import * as cheerio from "cheerio";

export type SearchResult = { title: string; url: string; snippet: string; source: string; };
export type SearchRequest = { query: string; maxResults: number; country?: string; language?: string; };
export type DocsSearchRequest = SearchRequest & { library: string };

function parseHtmlResults(html: string, selector: string, source: string, max: number): SearchResult[] {
  const $ = cheerio.load(html), seen = new Set<string>(), results: SearchResult[] = [];
  $(selector).each((_, el) => {
    if (results.length >= max) return false;
    const title = $(el).find(source === "google" ? "h3" : ".result__title, .result-link").text().trim();
    const urlStr = $(el).attr("href") || $(el).find("a").attr("href") || "";
    let url = urlStr.startsWith("/url?q=") ? new URL(urlStr, "https://google.com").searchParams.get("q") : (urlStr.includes("uddg=") ? new URL(urlStr, "https://ddg.com").searchParams.get("uddg") : urlStr);
    if (!title || !url || !url.startsWith("http") || seen.has(url)) return;
    seen.add(url);
    results.push({ title, url, snippet: $(el).parent().text().replace(/\s+/g, " ").trim().slice(0, 800), source });
  });
  return results;
}

async function fetchSearch(url: string, headers: Record<string, string>): Promise<string> {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

export async function searchGoogle(req: SearchRequest): Promise<SearchResult[]> {
  const lang = req.language || "en", gl = req.country || "us";
  
  if (config.provider === "duckduckgo-html") {
    const html = await fetchSearch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(req.query)}&kl=${gl}-${lang}`, { "user-agent": "Mozilla/5.0", "accept-language": `${lang},en;q=0.9` });
    return parseHtmlResults(html, ".result, .result-link", "duckduckgo", req.maxResults);
  }
  
  if (config.provider === "google-html") {
    const html = await fetchSearch(`https://www.google.com/search?q=${encodeURIComponent(req.query)}&num=${req.maxResults}&gbv=1&hl=${lang}&gl=${gl}`, { "user-agent": "Mozilla/5.0", "accept-language": `${lang},en;q=0.9` });
    if (html.includes("unusual traffic")) throw new Error("Google Rate Limited");
    return parseHtmlResults(html, "a:has(h3)", "google", req.maxResults);
  }
  
  if (config.provider === "serper" || config.provider === "google-cse") {
    const url = config.provider === "serper" ? "https://google.serper.dev/search" : `https://customsearch.googleapis.com/customsearch/v1?key=${config.googleApiKey}&cx=${config.googleCseId}&q=${req.query}&num=${req.maxResults}`;
    const opts = config.provider === "serper" ? { method: "POST", headers: { "X-API-KEY": config.serperApiKey!, "content-type": "application/json" }, body: JSON.stringify({ q: req.query, num: req.maxResults, gl, hl: lang }) } : {};
    const res = await (await fetch(url, opts)).json() as any;
    const items = res.organic || res.items || [];
    return items.slice(0, req.maxResults).map((i: any) => ({ title: i.title, url: i.link, snippet: i.snippet, source: "google" }));
  }
  
  throw new Error("Unknown SEARCH_PROVIDER");
}

export async function searchDocs(r: DocsSearchRequest): Promise<SearchResult[]> {
  const domains: Record<string, string> = { python: "docs.python.org", rust: "docs.rs OR site:doc.rust-lang.org", react: "react.dev", node: "nodejs.org/docs" };
  const filter = domains[r.library.toLowerCase()] || `${r.library}.com OR site:${r.library}.dev`;
  return searchGoogle({ ...r, query: `${r.query} site:${filter}` });
}
