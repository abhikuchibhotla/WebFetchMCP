import { lookup } from "node:dns/promises";
import net from "node:net";
import TurndownService from "turndown";
import { config } from "./config.js";

const LOCAL_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
export type WebPage = { url: string; title: string; text: string; contentType: string; truncated: boolean };

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) return /^(0|10|127|169\.254|172\.(1[6-9]|2[0-9]|3[0-1])|192\.168|22[4-9]|2[3-5][0-9])\./.test(ip);
  return /^([fF][cCdD]|fe80:|::1$|::ffff:(127|10|192\.168|172\.(1[6-9]|2[0-9]|3[0-1]))\.)/.test(ip.toLowerCase());
}

async function validateUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) throw new Error("Invalid URL or blocked port/credentials.");
  const h = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(h) || /\.(local|localhost|internal|home|lan)$/.test(h)) throw new Error("Blocked internal domain.");
  if (config.blocklist.some(p => h === p || h.endsWith(p.slice(1)))) throw new Error("Blocked by policy.");
  if (config.allowlist.length && !config.allowlist.some(p => h === p || h.endsWith(p.slice(1)))) throw new Error("Not in allowlist.");
  if (net.isIP(h)) { if (isPrivate(h)) throw new Error("Private IP."); return u; }
  const ips = await lookup(h, { all: true, verbatim: true });
  if (!ips.length || ips.some(i => isPrivate(i.address))) throw new Error("Resolves to private IP.");
  return u;
}

async function fetchBody(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") || 0) > config.maxResponseBytes) throw new Error("Too large");
  if (!res.body) return "";
  let size = 0, chunks: Uint8Array[] = [];
  for await (const chunk of res.body as any) {
    size += chunk.byteLength;
    if (size > config.maxResponseBytes) throw new Error("Exceeded 2MB limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function readWebPage(rawUrl: string, maxChars = config.maxPageChars): Promise<WebPage> {
  let url = await validateUrl(rawUrl);

  let res: Response | undefined;
  for (let i = 0; i < 5; i++) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
    try { res = await fetch(url, { redirect: "manual", signal: ctrl.signal, headers: { accept: "text/html,text/plain", "user-agent": "webfetch-mcp/0.1" } }); }
    finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400) { url = await validateUrl(new URL(res.headers.get("location")!, url).href); continue; }
    break;
  }
  if (!res || !res.ok) throw new Error(`Fetch failed: ${res?.status}`);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("text/html") && !type.includes("text/plain")) throw new Error("Unsupported type");

  let text = await fetchBody(res);
  let title = url.hostname;
  if (type.includes("text/html")) {
    const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match) title = match[1].trim();
    
    // Quick regex to kill massive script/style blocks before turndown
    text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
    
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).keep(["pre", "code"]);
    text = td.turndown(text);
  }
  text = text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("No readable text found.");

  const page = { url: url.href, title, text, contentType: type };
  return { ...page, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
