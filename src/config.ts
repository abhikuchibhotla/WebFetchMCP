const DEFAULT_MAX_PAGE_CHARS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

function integerFromEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function listFromEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function providersFromEnv(): string[] {
  const configured = listFromEnv("SEARCH_PROVIDERS");
  if (configured.length > 0) return configured;
  return [(process.env.SEARCH_PROVIDER ?? "duckduckgo-html").toLowerCase()];
}

export const config = {
  providers: providersFromEnv(),
  searxngUrl: process.env.SEARXNG_URL?.replace(/\/$/, ""),
  serperApiKey: process.env.SERPER_API_KEY,
  googleApiKey: process.env.GOOGLE_API_KEY,
  googleCseId: process.env.GOOGLE_CSE_ID,
  allowlist: listFromEnv("WEB_ALLOWLIST"),
  blocklist: listFromEnv("WEB_BLOCKLIST"),
  maxPageChars: integerFromEnv("MAX_PAGE_CHARS", DEFAULT_MAX_PAGE_CHARS, 1_000, 100_000),
  fetchTimeoutMs: integerFromEnv("FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS, 1_000, 60_000),
  maxResponseBytes: 2 * 1024 * 1024
} as const;
