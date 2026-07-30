import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cachedFetch,
  clearCache,
  invalidate,
  isFresh,
  isStorable,
  setCacheScope,
} from "../../examples/webext/src/cache.js";

const URL_A = "httpx://site@example.org/dir/page.html";
const URL_B = "httpx://site@example.org/other.html";

beforeEach(async () => {
  setCacheScope("alice@example.org");
  await clearCache();
});
afterEach(async () => {
  setCacheScope("alice@example.org");
  await clearCache();
});

/** A server whose responses and request headers the test controls. */
function server(
  handler: (headers: Record<string, string> | undefined, call: number) => Response,
) {
  const seen: (Record<string, string> | undefined)[] = [];
  const fetcher = (headers?: Record<string, string>) => {
    seen.push(headers);
    return Promise.resolve(handler(headers, seen.length));
  };
  return { fetcher, seen, get calls() { return seen.length; } };
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...headers },
  });

describe("isFresh", () => {
  const now = 1_700_000_000_000;
  const headers = (init: Record<string, string>) =>
    new Headers({ "x-httpx-stored-at": String(now - 10_000), ...init });

  it("honors max-age against the stored age", () => {
    expect(isFresh(headers({ "cache-control": "max-age=60" }), now)).toBe(true);
    expect(isFresh(headers({ "cache-control": "max-age=5" }), now)).toBe(false);
  });

  it("adds the Age header to the resident time", () => {
    expect(isFresh(headers({ "cache-control": "max-age=60", age: "100" }), now)).toBe(
      false,
    );
  });

  it("treats no-cache as never fresh, whatever max-age says", () => {
    expect(
      isFresh(headers({ "cache-control": "max-age=600, no-cache" }), now),
    ).toBe(false);
  });

  it("falls back to Expires", () => {
    expect(
      isFresh(headers({ expires: new Date(now + 60_000).toUTCString() }), now),
    ).toBe(true);
    expect(
      isFresh(headers({ expires: new Date(now - 60_000).toUTCString() }), now),
    ).toBe(false);
    expect(isFresh(headers({ expires: "not a date" }), now)).toBe(false);
  });

  it("requires an explicit lifetime — no heuristic freshness", () => {
    expect(isFresh(headers({}), now)).toBe(false);
    expect(isFresh(headers({ etag: '"v1"' }), now)).toBe(false);
  });
});

describe("isStorable", () => {
  it("stores only 200s without no-store, under the size cap", () => {
    expect(isStorable(html("x"), 10)).toBe(true);
    expect(isStorable(html("x", { "cache-control": "no-store" }), 10)).toBe(false);
    expect(isStorable(new Response("x", { status: 404 }), 10)).toBe(false);
    expect(isStorable(new Response("x", { status: 500 }), 10)).toBe(false);
    expect(isStorable(html("x"), 9 * 1024 * 1024)).toBe(false);
  });

  it("stores a no-cache response — it just must be revalidated first", () => {
    expect(isStorable(html("x", { "cache-control": "no-cache" }), 10)).toBe(true);
  });
});

describe("cachedFetch", () => {
  it("reports a miss and stores the response", async () => {
    const s = server(() => html("<p>one</p>", { "cache-control": "max-age=60" }));
    const first = await cachedFetch(URL_A, s.fetcher);
    expect(first.state).toBe("miss");
    expect(await first.response.text()).toBe("<p>one</p>");
    expect(s.calls).toBe(1);
  });

  it("serves a fresh entry without contacting the server", async () => {
    const s = server(() => html("<p>one</p>", { "cache-control": "max-age=60" }));
    await cachedFetch(URL_A, s.fetcher);
    const second = await cachedFetch(URL_A, s.fetcher);
    expect(second.state).toBe("hit");
    expect(await second.response.text()).toBe("<p>one</p>");
    expect(s.calls).toBe(1); // still one
  });

  it("revalidates with If-None-Match and serves the cached body on 304", async () => {
    const s = server((headers, call) => {
      if (call === 1) return html("<p>body</p>", { etag: '"v1"' });
      expect(headers?.["if-none-match"]).toBe('"v1"');
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    });

    const first = await cachedFetch(URL_A, s.fetcher);
    expect(first.state).toBe("miss");
    await first.response.text();

    const second = await cachedFetch(URL_A, s.fetcher);
    expect(second.state).toBe("revalidated");
    expect(second.response.status).toBe(200);
    expect(await second.response.text()).toBe("<p>body</p>");
    expect(s.calls).toBe(2);
  });

  it("sends If-Modified-Since when that is the only validator", async () => {
    const modified = new Date(1_600_000_000_000).toUTCString();
    const s = server((headers, call) =>
      call === 1
        ? html("<p>body</p>", { "last-modified": modified })
        : (expect(headers?.["if-modified-since"]).toBe(modified),
          new Response(null, { status: 304 })),
    );
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("revalidated");
  });

  it("replaces the entry when revalidation returns a new body", async () => {
    const s = server((_headers, call) =>
      html(`<p>v${call}</p>`, { etag: `"v${call}"` }),
    );
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    const second = await cachedFetch(URL_A, s.fetcher);
    expect(second.state).toBe("miss");
    expect(await second.response.text()).toBe("<p>v2</p>");

    // The replacement is what is stored now.
    const third = await cachedFetch(URL_A, s.fetcher);
    expect(await third.response.text()).toBe("<p>v3</p>");
  });

  it("refreshes the lifetime from the 304's headers", async () => {
    const s = server((_headers, call) =>
      call === 1
        ? html("<p>body</p>", { etag: '"v1"', "cache-control": "max-age=0" })
        : new Response(null, {
            status: 304,
            headers: { etag: '"v1"', "cache-control": "max-age=600" },
          }),
    );
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("revalidated");
    // Now fresh for 600s, so no third request.
    const third = await cachedFetch(URL_A, s.fetcher);
    expect(third.state).toBe("hit");
    expect(s.calls).toBe(2);
  });

  it("does not store no-store responses", async () => {
    const s = server(() =>
      html("<p>secret</p>", { "cache-control": "no-store, max-age=600" }),
    );
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("miss");
    expect(s.calls).toBe(2);
  });

  it("does not store errors", async () => {
    const s = server(
      () => new Response("nope", { status: 404, headers: { "cache-control": "max-age=600" } }),
    );
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("miss");
  });

  it("reload skips freshness but still revalidates", async () => {
    const s = server((headers, call) => {
      if (call === 1) return html("<p>body</p>", { etag: '"v1"', "cache-control": "max-age=600" });
      expect(headers?.["if-none-match"]).toBe('"v1"');
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    });
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    const reloaded = await cachedFetch(URL_A, s.fetcher, { reload: true });
    expect(reloaded.state).toBe("revalidated");
    expect(await reloaded.response.text()).toBe("<p>body</p>");
  });

  it("keeps entries for different URLs apart", async () => {
    const s = server((_h, call) => html(`<p>${call}</p>`, { "cache-control": "max-age=60" }));
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    const other = await cachedFetch(URL_B, s.fetcher);
    expect(other.state).toBe("miss");
    expect(await other.response.text()).toBe("<p>2</p>");
    expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("hit");
  });

  it("preserves the content type through the cache", async () => {
    const s = server(() =>
      html("<p>x</p>", { "cache-control": "max-age=60", "content-type": "text/html; charset=utf-8" }),
    );
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    const hit = await cachedFetch(URL_A, s.fetcher);
    expect(hit.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("hides its bookkeeping header from callers", async () => {
    const s = server(() => html("<p>x</p>", { "cache-control": "max-age=60" }));
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    const hit = await cachedFetch(URL_A, s.fetcher);
    expect(hit.response.headers.get("x-httpx-stored-at")).toBeNull();
  });

  it("invalidate drops the entry", async () => {
    const s = server(() => html("<p>x</p>", { "cache-control": "max-age=600" }));
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    await invalidate(URL_A);
    expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("miss");
  });

  it("recovers when the server 304s with nothing cached", async () => {
    const s = server((_h, call) =>
      call === 1 ? new Response(null, { status: 304 }) : html("<p>full</p>"),
    );
    const result = await cachedFetch(URL_A, s.fetcher);
    expect(result.state).toBe("bypass");
    expect(await result.response.text()).toBe("<p>full</p>");
  });
});

describe("cache scoping", () => {
  it("never serves one account's entry to another", async () => {
    const s = server((_h, call) =>
      html(`<p>${call}</p>`, { "cache-control": "max-age=600" }),
    );
    setCacheScope("alice@example.org/laptop");
    await (await cachedFetch(URL_A, s.fetcher)).response.text();
    expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("hit");

    setCacheScope("bob@example.org");
    const other = await cachedFetch(URL_A, s.fetcher);
    expect(other.state).toBe("miss");
    expect(await other.response.text()).toBe("<p>2</p>");

    // Alice's copy is untouched, and the resource part of her JID is ignored.
    setCacheScope("alice@example.org/phone");
    const back = await cachedFetch(URL_A, s.fetcher);
    expect(back.state).toBe("hit");
    expect(await back.response.text()).toBe("<p>1</p>");
  });

  it("clearCache empties every account's partition", async () => {
    const s = server(() => html("<p>x</p>", { "cache-control": "max-age=600" }));
    for (const jid of ["alice@example.org", "bob@example.org"]) {
      setCacheScope(jid);
      await (await cachedFetch(URL_A, s.fetcher)).response.text();
    }
    await clearCache();
    for (const jid of ["alice@example.org", "bob@example.org"]) {
      setCacheScope(jid);
      expect((await cachedFetch(URL_A, s.fetcher)).state).toBe("miss");
    }
  });
});
