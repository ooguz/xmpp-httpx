import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contentTypeFor,
  createStaticHandler,
  etagFor,
  isWithin,
  resolveInRoot,
} from "../../src/cli/static-site.js";
import type { HttpxHandler, HttpxServerRequest } from "../../src/server/server.js";

/** A request as the server would hand it to a handler. */
function request(
  resource: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): HttpxServerRequest {
  return {
    from: "alice@example.org/laptop",
    to: "web.example.org",
    method: (init.method ?? "GET") as HttpxServerRequest["method"],
    resource,
    url: `httpx://web.example.org${resource}`,
    headers: new Headers(init.headers ?? {}),
    body: null,
    accept: { ibb: true, chunked: true, sipub: false, jingle: false },
  };
}

async function bodyOf(response: Awaited<ReturnType<HttpxHandler>>): Promise<string> {
  const body = (response as { body?: unknown }).body;
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return new Response(body as ReadableStream<Uint8Array>).text();
}

function statusOf(response: Awaited<ReturnType<HttpxHandler>>): number {
  return (response as { status?: number }).status ?? 200;
}

function headersOf(response: Awaited<ReturnType<HttpxHandler>>): Headers {
  return new Headers(((response as { headers?: HeadersInit }).headers ?? {}) as HeadersInit);
}

describe("static site handler", () => {
  let root: string;
  let outside: string;
  let handler: HttpxHandler;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "httpx-static-"));
    await writeFile(join(root, "index.html"), "<h1>home</h1>");
    await writeFile(join(root, "style.css"), "body{color:red}");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "index.html"), "<h1>sub</h1>");
    await writeFile(join(root, "sub", "page.html"), "<h1>page</h1>");
    // A sibling directory that shares the root's prefix — the classic way a
    // naive startsWith() containment check leaks.
    outside = `${root}-secrets`;
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "leak.txt"), "TOP SECRET");
    handler = createStaticHandler(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("serves the index for the root", async () => {
    const response = await handler(request("/"));
    expect(statusOf(response)).toBe(200);
    expect(headersOf(response).get("content-type")).toContain("text/html");
    expect(await bodyOf(response)).toBe("<h1>home</h1>");
  });

  it("gives a GET its content-length, so a small file can go inline", async () => {
    // Without it the server has to treat every file as a stream of unknown
    // length: an IBB session and its round trips for 13 bytes.
    const response = await handler(request("/index.html"));
    expect(headersOf(response).get("content-length")).toBe("13");
  });

  it("serves a file, with its type", async () => {
    const response = await handler(request("/style.css"));
    expect(statusOf(response)).toBe(200);
    expect(headersOf(response).get("content-type")).toContain("text/css");
    expect(await bodyOf(response)).toBe("body{color:red}");
  });

  it("serves the index of a subdirectory", async () => {
    expect(await bodyOf(await handler(request("/sub")))).toBe("<h1>sub</h1>");
    expect(await bodyOf(await handler(request("/sub/")))).toBe("<h1>sub</h1>");
    expect(await bodyOf(await handler(request("/sub/page.html")))).toBe("<h1>page</h1>");
  });

  it("ignores the query string when locating the file", async () => {
    expect(await bodyOf(await handler(request("/style.css?v=2")))).toBe("body{color:red}");
  });

  it("404s what is not there", async () => {
    expect(statusOf(await handler(request("/nope.html")))).toBe(404);
    expect(statusOf(await handler(request("/sub/nope/")))).toBe(404);
  });

  it("advertises validators and answers If-None-Match with a 304", async () => {
    const first = await handler(request("/index.html"));
    const etag = headersOf(first).get("etag")!;
    expect(etag).toBeTruthy();
    expect(headersOf(first).get("last-modified")).toBeTruthy();
    expect(headersOf(first).get("cache-control")).toBe("max-age=60");
    await bodyOf(first);

    const revalidated = await handler(
      request("/index.html", { headers: { "if-none-match": etag } }),
    );
    expect(statusOf(revalidated)).toBe(304);
    expect(await bodyOf(revalidated)).toBe("");

    const stale = await handler(
      request("/index.html", { headers: { "if-none-match": '"nope"' } }),
    );
    expect(statusOf(stale)).toBe(200);
    expect(await bodyOf(stale)).toBe("<h1>home</h1>");
  });

  it("honors a custom max-age, and omits it when zero", async () => {
    const eager = createStaticHandler(root, { maxAgeSeconds: 3600 });
    expect(headersOf(await eager(request("/"))).get("cache-control")).toBe(
      "max-age=3600",
    );
    const none = createStaticHandler(root, { maxAgeSeconds: 0 });
    expect(headersOf(await none(request("/"))).get("cache-control")).toBeNull();
  });

  it("answers HEAD with headers and a content-length, no body", async () => {
    const response = await handler(request("/index.html", { method: "HEAD" }));
    expect(statusOf(response)).toBe(200);
    expect(headersOf(response).get("content-length")).toBe("13");
    expect(await bodyOf(response)).toBe("");
  });

  it("refuses methods that would change something", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await handler(request("/", { method }));
      expect(statusOf(response), method).toBe(405);
      expect(headersOf(response).get("allow")).toBe("GET, HEAD");
    }
  });

  it("never serves anything outside the root", async () => {
    // `..` in an absolute path collapses, as in every HTTP server, so these
    // land inside the root and 404 rather than being refused. What matters is
    // that no outside file is ever returned.
    for (const resource of [
      "/../etc/passwd",
      "/sub/../../etc/passwd",
      "/%2e%2e%2f%2e%2e%2fetc/passwd",
      "/..%2f..%2fetc/passwd",
      "/sub/%2e%2e/%2e%2e/etc/passwd",
      "/../../../../../../etc/passwd",
    ]) {
      const response = await handler(request(resource));
      expect([403, 404], resource).toContain(statusOf(response));
      expect(await bodyOf(response), resource).not.toContain("root:");
    }
  });

  it("does not serve a sibling directory that shares the root's prefix", async () => {
    // root is /tmp/httpx-static-XXXX, outside is /tmp/httpx-static-XXXX-secrets:
    // a startsWith(root) check without the separator would serve this.
    const response = await handler(request("/../-secrets/leak.txt"));
    expect([403, 404]).toContain(statusOf(response));
    expect(await bodyOf(response)).not.toContain("TOP SECRET");
  });

  it("refuses a symlink that leads out of the root", async () => {
    // resolve() does not follow links, so this is the second containment check.
    await symlink(join(outside, "leak.txt"), join(root, "escape.txt"));
    const response = await handler(request("/escape.txt"));
    expect(statusOf(response)).toBe(403);
    expect(await bodyOf(response)).not.toContain("TOP SECRET");
  });

  it("still serves a symlink that stays inside the root", async () => {
    await symlink(join(root, "sub", "page.html"), join(root, "linked.html"));
    expect(await bodyOf(await handler(request("/linked.html")))).toBe("<h1>page</h1>");
  });

  it("refuses malformed percent-encoding and NUL bytes", async () => {
    expect(statusOf(await handler(request("/%ZZ")))).toBe(403);
    expect(statusOf(await handler(request("/index.html%00.txt")))).toBe(403);
  });
});

describe("resolveInRoot", () => {
  it("keeps every resolved path inside the root", () => {
    expect(resolveInRoot("/srv/site", "/a/b.html")).toBe("/srv/site/a/b.html");
    expect(resolveInRoot("/srv/site", "/")).toBe("/srv/site");
    // Absolute-path traversal collapses instead of escaping — the resolved path
    // is inside the root, which is the property that matters.
    expect(resolveInRoot("/srv/site", "/../secret")).toBe("/srv/site/secret");
    expect(resolveInRoot("/srv/site", "/../site-secrets/x")).toBe(
      "/srv/site/site-secrets/x",
    );
    expect(resolveInRoot("/srv/site", "/%2e%2e/secret")).toBe("/srv/site/secret");
  });

  it("rejects what it cannot decode", () => {
    expect(resolveInRoot("/srv/site", "/%ZZ")).toBeNull();
    expect(resolveInRoot("/srv/site", "/a%00b")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("/a/b.html")).toContain("text/html");
    expect(contentTypeFor("/a/b.PNG")).toBe("image/png");
    expect(contentTypeFor("/a/b.woff2")).toBe("font/woff2");
    expect(contentTypeFor("/a/b.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("/a/noext")).toBe("application/octet-stream");
  });
});

describe("etagFor", () => {
  it("changes with size or mtime", async () => {
    const info = await stat(".");
    const base = etagFor(100, 1_700_000_000_000);
    expect(etagFor(100, 1_700_000_000_000)).toBe(base);
    expect(etagFor(101, 1_700_000_000_000)).not.toBe(base);
    expect(etagFor(100, 1_700_000_000_001)).not.toBe(base);
    expect(etagFor(info.size, info.mtimeMs)).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
  });
});

describe("isWithin", () => {
  it("requires a real path boundary, not a string prefix", () => {
    expect(isWithin("/srv/site", "/srv/site")).toBe(true);
    expect(isWithin("/srv/site", "/srv/site/a/b")).toBe(true);
    expect(isWithin("/srv/site", "/srv/site-secrets/x")).toBe(false);
    expect(isWithin("/srv/site", "/srv")).toBe(false);
    expect(isWithin("/srv/site", "/etc/passwd")).toBe(false);
  });
});
