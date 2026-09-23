import { describe, expect, it } from "vitest";
import { bareJid, withRateLimit } from "../../src/server/rate-limit.js";
import type { HttpxHandler, HttpxServerRequest } from "../../src/server/server.js";

function request(from: string, resource = "/"): HttpxServerRequest {
  return {
    from,
    to: "web.example.org",
    method: "GET",
    resource,
    url: `httpx://web.example.org${resource}`,
    headers: new Headers(),
    body: null,
    extensions: [],
    accept: { ibb: true, chunked: true, sipub: false, jingle: false },
  };
}

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

/** A content handler that counts how often it was actually reached. */
function inner(): { handler: HttpxHandler; calls: () => number } {
  let calls = 0;
  return {
    handler: () => {
      calls += 1;
      return { status: 200, body: "ok" };
    },
    calls: () => calls,
  };
}

const statusOf = (response: unknown) => (response as { status?: number }).status;
const headerOf = (response: unknown, name: string) =>
  new Headers(((response as { headers?: HeadersInit }).headers ?? {}) as HeadersInit).get(
    name,
  );

describe("withRateLimit", () => {
  it("passes requests through while tokens remain", async () => {
    const { handler, calls } = inner();
    const time = clock();
    const limited = withRateLimit(handler, {
      ratePerSecond: 1,
      burst: 3,
      now: time.now,
    });

    for (let i = 0; i < 3; i++) {
      expect(statusOf(await limited(request("alice@example.org/a")))).toBe(200);
    }
    expect(calls()).toBe(3);
  });

  it("refuses with 429 and Retry-After once the bucket is empty", async () => {
    const { handler, calls } = inner();
    const time = clock();
    const limited = withRateLimit(handler, {
      ratePerSecond: 1,
      burst: 2,
      now: time.now,
    });

    await limited(request("alice@example.org/a"));
    await limited(request("alice@example.org/a"));
    const refused = await limited(request("alice@example.org/a"));

    expect(statusOf(refused)).toBe(429);
    expect(headerOf(refused, "retry-after")).toBe("1");
    expect(calls()).toBe(2); // the origin was never called for the third
  });

  it("never tells a client to retry sooner than a token exists", async () => {
    const time = clock();
    const limited = withRateLimit(inner().handler, {
      ratePerSecond: 0.2, // one token every 5s
      burst: 1,
      now: time.now,
    });
    await limited(request("alice@example.org/a"));
    const refused = await limited(request("alice@example.org/a"));
    expect(headerOf(refused, "retry-after")).toBe("5");
  });

  it("refills over time, up to the burst ceiling", async () => {
    const { handler } = inner();
    const time = clock();
    const limited = withRateLimit(handler, {
      ratePerSecond: 2,
      burst: 2,
      now: time.now,
    });

    await limited(request("alice@example.org/a"));
    await limited(request("alice@example.org/a"));
    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(429);

    time.advance(500); // one token at 2/s
    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(200);
    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(429);

    time.advance(60_000); // long idle: refills to burst, not beyond
    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(200);
    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(200);
    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(429);
  });

  it("gives each bare JID its own bucket", async () => {
    const time = clock();
    const limited = withRateLimit(inner().handler, {
      ratePerSecond: 1,
      burst: 1,
      now: time.now,
    });

    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(200);
    expect(statusOf(await limited(request("alice@example.org/a")))).toBe(429);
    // A different account is unaffected.
    expect(statusOf(await limited(request("bob@example.org/b")))).toBe(200);
  });

  it("does not let one account multiply its quota with extra resources", async () => {
    const time = clock();
    const limited = withRateLimit(inner().handler, {
      ratePerSecond: 1,
      burst: 1,
      now: time.now,
    });

    expect(statusOf(await limited(request("alice@example.org/laptop")))).toBe(200);
    expect(statusOf(await limited(request("alice@example.org/phone")))).toBe(429);
    expect(statusOf(await limited(request("alice@example.org")))).toBe(429);
  });

  it("reports refusals to the caller for logging and metrics", async () => {
    const seen: { from: string; retryAfter: number }[] = [];
    const time = clock();
    const limited = withRateLimit(inner().handler, {
      ratePerSecond: 1,
      burst: 1,
      now: time.now,
      onLimited: (from, retryAfter) => seen.push({ from, retryAfter }),
    });

    await limited(request("alice@example.org/a"));
    await limited(request("alice@example.org/a"));
    expect(seen).toEqual([{ from: "alice@example.org/a", retryAfter: 1 }]);
  });

  it("defaults burst to the rate, at least one", async () => {
    const time = clock();
    const perSecond = withRateLimit(inner().handler, { ratePerSecond: 3, now: time.now });
    for (let i = 0; i < 3; i++) {
      expect(statusOf(await perSecond(request("a@b/c")))).toBe(200);
    }
    expect(statusOf(await perSecond(request("a@b/c")))).toBe(429);

    const trickle = withRateLimit(inner().handler, { ratePerSecond: 0.1, now: time.now });
    expect(statusOf(await trickle(request("x@y/z")))).toBe(200);
    expect(statusOf(await trickle(request("x@y/z")))).toBe(429);
  });

  it("bounds how many senders it tracks, without ever erroring", async () => {
    const time = clock();
    const limited = withRateLimit(inner().handler, {
      ratePerSecond: 1,
      burst: 1,
      maxTracked: 2,
      now: time.now,
    });

    // Three distinct senders, each using its single token.
    for (const jid of ["a@x/1", "b@x/1", "c@x/1"]) {
      expect(statusOf(await limited(request(jid)))).toBe(200);
      time.advance(1); // distinct lastSeen ordering
    }
    // "a" was evicted to make room, so it gets a fresh bucket rather than an
    // error — the documented trade for a bounded map.
    expect(statusOf(await limited(request("a@x/1")))).toBe(200);
    // "c", the most recent, is still tracked and still limited.
    expect(statusOf(await limited(request("c@x/1")))).toBe(429);
  });

  it("rejects a nonsensical rate at construction, not at request time", () => {
    expect(() => withRateLimit(inner().handler, { ratePerSecond: 0 })).toThrow(RangeError);
    expect(() => withRateLimit(inner().handler, { ratePerSecond: -1 })).toThrow(RangeError);
    expect(() => withRateLimit(inner().handler, { ratePerSecond: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it("explains itself in the body", async () => {
    const time = clock();
    const limited = withRateLimit(inner().handler, {
      ratePerSecond: 1,
      burst: 1,
      now: time.now,
    });
    await limited(request("a@b/c"));
    const refused = (await limited(request("a@b/c"))) as { body?: string };
    expect(refused.body).toContain("rate limit exceeded");
    expect(headerOf(refused, "content-type")).toContain("text/plain");
  });
});

describe("bareJid", () => {
  it("strips the resource, and copes without one", () => {
    expect(bareJid("alice@example.org/laptop")).toBe("alice@example.org");
    expect(bareJid("alice@example.org")).toBe("alice@example.org");
    expect(bareJid("web.example.org")).toBe("web.example.org");
  });
});
