import type { HttpxHandler, HttpxServerRequest } from "./server.js";

/**
 * Per-requester rate limiting: a token bucket keyed by **bare** JID, wrapping a
 * handler.
 *
 * Why a handler wrapper rather than an `authorize` hook, which is where the
 * roadmap put it: `AuthorizeFn` can only say yes or no, and the server turns a
 * no into `forbidden`. A throttled client should be told to slow down, not that
 * it is not allowed — so this returns a real **429 with `Retry-After`**, which a
 * client can act on. It costs no more: the server hands the handler an unread
 * body stream, so refusing here still avoids both the origin call and reading
 * the request.
 *
 * Keyed on the bare JID because resources are cheap to mint: limiting
 * `alice@example.org/laptop` separately from `/phone` would let one account
 * multiply its own quota at will.
 *
 * Browser-safe: the only ambient dependency is a clock, and that is injectable.
 */

export interface RateLimitOptions {
  /** Sustained requests per second, per bare JID. May be fractional. */
  ratePerSecond: number;
  /** Requests allowed in a burst. Defaults to `ceil(ratePerSecond)`, min 1. */
  burst?: number;
  /**
   * Cap on how many JIDs are tracked at once, so a flood of distinct senders
   * cannot grow the map without bound. When full, the least recently seen entry
   * is dropped — which at worst gives that sender a fresh bucket, never an
   * error. Default 10 000.
   */
  maxTracked?: number;
  /** Called for each refused request, for logging and metrics. */
  onLimited?: (from: string, retryAfterSeconds: number) => void;
  /** Injectable clock in milliseconds, for tests. */
  now?: () => number;
}

interface Bucket {
  /** Tokens available, fractional between refills. */
  tokens: number;
  /** When `tokens` was last recomputed. */
  updated: number;
}

export function bareJid(jid: string): string {
  return jid.split("/")[0] ?? jid;
}

/**
 * Wraps `handler` so each bare JID may make `burst` requests immediately and
 * `ratePerSecond` sustained. Refusals get a 429 and a `Retry-After`.
 */
export function withRateLimit(
  handler: HttpxHandler,
  options: RateLimitOptions,
): HttpxHandler {
  const rate = options.ratePerSecond;
  if (!(rate > 0)) {
    throw new RangeError(`ratePerSecond must be positive, got ${rate}`);
  }
  const burst = Math.max(1, options.burst ?? Math.ceil(rate));
  const maxTracked = Math.max(1, options.maxTracked ?? 10_000);
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  /** Drops the least recently seen bucket; only called when at capacity. */
  const evictOldest = (): void => {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, bucket] of buckets) {
      if (bucket.updated < oldestAt) {
        oldestAt = bucket.updated;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  };

  /** Consumes a token; returns 0 when allowed, else seconds to wait. */
  const consume = (key: string): number => {
    const at = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxTracked) evictOldest();
      bucket = { tokens: burst, updated: at };
      buckets.set(key, bucket);
    } else {
      const elapsedSeconds = Math.max(0, at - bucket.updated) / 1000;
      bucket.tokens = Math.min(burst, bucket.tokens + elapsedSeconds * rate);
      bucket.updated = at;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    // Ceil so Retry-After never tells a client to come back too early.
    return Math.max(1, Math.ceil((1 - bucket.tokens) / rate));
  };

  return async (req: HttpxServerRequest) => {
    const key = bareJid(req.from);
    const retryAfter = consume(key);
    if (retryAfter === 0) return handler(req);

    options.onLimited?.(req.from, retryAfter);
    return {
      status: 429,
      statusMessage: "Too Many Requests",
      headers: {
        "retry-after": String(retryAfter),
        "content-type": "text/plain; charset=utf-8",
      },
      body: `rate limit exceeded; retry in ${retryAfter}s\n`,
    };
  };
}
