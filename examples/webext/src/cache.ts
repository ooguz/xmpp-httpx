/**
 * HTTP caching for httpx responses, on the Cache API.
 *
 * Two wrinkles shape this module:
 *
 * 1. The Cache API only accepts http(s) request keys, so every httpx URL is
 *    mapped to a synthetic `https://httpx.invalid/<encoded>` key. Nothing ever
 *    fetches that URL — it is a cache key, not an address.
 * 2. Response bodies are buffered once and re-wrapped for both the caller and
 *    the cache. Teeing a streaming body instead would deadlock whenever one
 *    side (the cache, or a caller that never reads) applies backpressure.
 *
 * Freshness follows the parts of RFC 9111 a browser cache actually needs:
 * `no-store`, `no-cache`, `max-age`, `Expires`, `Age`, and revalidation with
 * `If-None-Match`/`If-Modified-Since` producing a real 304.
 */

const CACHE_PREFIX = "httpx-v1:";
const KEY_ORIGIN = "https://httpx.invalid/";
/** Header recording when we stored the entry, for age computation. */
const STORED_AT = "x-httpx-stored-at";
/** Bodies larger than this are served but not stored. */
const MAX_CACHED_BYTES = 8 * 1024 * 1024;

export type CacheState =
  /** Served from cache without asking the server. */
  | "hit"
  /** Server confirmed the cached copy with a 304. */
  | "revalidated"
  /** Fetched from the server (and stored, if storable). */
  | "miss"
  /** Not cacheable, or the Cache API is unavailable. */
  | "bypass";

export interface CachedResult {
  response: Response;
  state: CacheState;
}

/** Extra request headers a revalidation adds. */
export type Fetcher = (headers?: Record<string, string>) => Promise<Response>;

function cacheKey(httpxUrl: string): string {
  return KEY_ORIGIN + encodeURIComponent(httpxUrl);
}

/**
 * Which account's cache we are using. httpx servers authorize per requester
 * JID — an origin proxy even forwards it as `X-Httpx-From` — so one account's
 * responses must never be served to another. Partitioning by bare JID makes
 * that structural instead of relying on remembering to clear on switch.
 */
let scope = "anonymous";

export function setCacheScope(jid: string): void {
  const bare = jid.split("/")[0]?.toLowerCase() ?? "";
  scope = bare === "" ? "anonymous" : bare;
}

async function openCache(): Promise<Cache | undefined> {
  try {
    return await caches.open(CACHE_PREFIX + scope);
  } catch {
    return undefined; // no Cache API (or storage denied) — degrade to no cache
  }
}

interface Directives {
  noStore: boolean;
  noCache: boolean;
  maxAge?: number;
}

function directives(headers: Headers): Directives {
  const value = (headers.get("cache-control") ?? "").toLowerCase();
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/.exec(value);
  return {
    noStore: /(?:^|,)\s*no-store\b/.test(value),
    noCache: /(?:^|,)\s*no-cache\b/.test(value),
    ...(maxAge?.[1] !== undefined ? { maxAge: Number(maxAge[1]) } : {}),
  };
}

/** Seconds the stored response has been resident, per RFC 9111 §4.2.3. */
function ageSeconds(headers: Headers, now: number): number {
  const storedAt = Number(headers.get(STORED_AT) ?? NaN);
  const base = Number.isFinite(storedAt) ? storedAt : now;
  const initialAge = Number(headers.get("age") ?? 0);
  return Math.max(0, (now - base) / 1000 + (Number.isFinite(initialAge) ? initialAge : 0));
}

/** True when the stored response may be used without contacting the server. */
export function isFresh(headers: Headers, now = Date.now()): boolean {
  const { noCache, maxAge } = directives(headers);
  if (noCache) return false;
  const age = ageSeconds(headers, now);
  if (maxAge !== undefined) return age < maxAge;
  const expires = headers.get("expires");
  if (expires) {
    const deadline = Date.parse(expires);
    if (Number.isFinite(deadline)) return now < deadline;
  }
  return false; // no explicit lifetime — always revalidate
}

/** True when a response may be stored at all. */
export function isStorable(response: Response, size: number): boolean {
  if (response.status !== 200) return false;
  if (size > MAX_CACHED_BYTES) return false;
  if (directives(response.headers).noStore) return false;
  return true;
}

/** Validators that let us ask "is my copy still good?". */
function validators(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const etag = headers.get("etag");
  if (etag) out["if-none-match"] = etag;
  const modified = headers.get("last-modified");
  if (modified) out["if-modified-since"] = modified;
  return out;
}

function withStoredAt(headers: Headers, now: number): Headers {
  const copy = new Headers(headers);
  copy.set(STORED_AT, String(now));
  return copy;
}

/** The headers we hand back to callers, minus our bookkeeping. */
function withoutBookkeeping(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete(STORED_AT);
  return copy;
}

async function store(
  cache: Cache,
  href: string,
  response: Response,
  body: Blob,
  now: number,
): Promise<void> {
  try {
    await cache.put(
      cacheKey(href),
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: withStoredAt(response.headers, now),
      }),
    );
  } catch {
    // Quota, private mode, or a body the Cache API refuses: not fatal.
  }
}

function rebuild(response: Response, body: Blob): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: withoutBookkeeping(response.headers),
  });
}

/**
 * Fetches `href` through the cache. `reload: true` skips the freshness check
 * (what the reload button does) but still revalidates, so an unchanged page
 * costs one 304 instead of a full body.
 */
export async function cachedFetch(
  href: string,
  fetcher: Fetcher,
  options: { reload?: boolean } = {},
): Promise<CachedResult> {
  const cache = await openCache();
  if (!cache) return { response: await fetcher(), state: "bypass" };

  const now = Date.now();
  const stored = await cache.match(cacheKey(href));

  if (stored && !options.reload && isFresh(stored.headers, now)) {
    return { response: rebuild(stored, await stored.blob()), state: "hit" };
  }

  const conditional = stored ? validators(stored.headers) : {};
  const response = await fetcher(
    Object.keys(conditional).length > 0 ? conditional : undefined,
  );

  if (response.status === 304 && stored) {
    // Refresh the stored metadata (new Cache-Control, new Date) but keep the
    // body the server just told us is still current.
    const body = await stored.blob();
    const merged = new Headers(stored.headers);
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== "content-length") merged.set(name, value);
    }
    const refreshed = new Response(body, {
      status: 200,
      statusText: "OK",
      headers: withStoredAt(merged, now),
    });
    await store(cache, href, refreshed, body, now);
    return { response: rebuild(refreshed, body), state: "revalidated" };
  }

  if (response.status === 304) {
    // 304 with nothing cached (a stale key we evicted): ask again, plainly.
    const full = await fetcher();
    return { response: full, state: "bypass" };
  }

  const body = await response.blob();
  if (isStorable(response, body.size)) {
    await store(cache, href, response, body, now);
  } else if (stored) {
    await invalidate(href); // superseded by an uncacheable response
  }
  return { response: rebuild(response, body), state: "miss" };
}

/** Drops any cached copy of `href` — used after unsafe methods, as browsers do. */
export async function invalidate(href: string): Promise<void> {
  const cache = await openCache();
  await cache?.delete(cacheKey(href)).catch(() => false);
}

/**
 * Empties every account's cache, not just the current scope — "Clear cache"
 * has to mean it, including partitions left behind by accounts since removed.
 */
export async function clearCache(): Promise<void> {
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX)) await caches.delete(name);
    }
  } catch {
    // Nothing to clear.
  }
}
