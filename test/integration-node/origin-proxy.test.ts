import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOriginProxyHandler } from "../../src/node/origin-proxy.js";
import type { HttpxServerRequest } from "../../src/server/server.js";

/**
 * A reverse proxy fronts exactly one origin. These cover the request targets
 * that carry their own authority and would otherwise let the requester pick
 * what the gateway fetches from inside its own network — with `x-httpx-from`
 * naming an XMPP-authenticated JID to whoever answers.
 *
 * Nothing here reaches the network: a refused target is refused before fetch.
 */

function request(
  resource: string,
  method: HttpxServerRequest["method"] = "GET",
): HttpxServerRequest {
  return {
    from: "alice@example.org/laptop",
    to: "gateway.example.org",
    method,
    resource,
    url: resource,
    headers: new Headers(),
    body: null,
    extensions: [],
    accept: { ibb: true, chunked: true, sipub: false, jingle: false },
  };
}

describe("origin proxy request targets", () => {
  const handler = createOriginProxyHandler("http://localhost:8080");

  it("refuses a target naming another origin, without fetching it", async () => {
    for (const resource of [
      // Absolute-form, now that the codec accepts it.
      "http://169.254.169.254/latest/meta-data/",
      "https://example.net/collect",
      // Protocol-relative: always passed the origin-form check, because it
      // starts with "/", and `new URL` drops the base for it just the same.
      "//169.254.169.254/latest/meta-data/",
      // Same host, different port or scheme is still a different origin.
      "http://localhost:9090/admin",
      "https://localhost:8080/admin",
    ]) {
      const response = await handler(request(resource));
      expect(
        (response as { status?: number }).status,
        `${resource} must not be proxied`,
      ).toBe(400);
    }
  });

  it("refuses CONNECT, whose target is an authority rather than a path", async () => {
    const response = await handler(request("example.net:443", "CONNECT"));
    expect((response as { status?: number }).status).toBe(400);
  });
});

describe("origin proxy response lengths", () => {
  // A real local origin: whether the length survives depends on what fetch
  // did to the body, which only a real response exercises.
  let origin: Server;
  let base: string;
  beforeAll(async () => {
    origin = createServer((req, res) => {
      if (req.url === "/plain") {
        res.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
        res.end("hello");
      } else {
        const body = gzipSync("hello, compressed");
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": "gzip",
          "content-length": String(body.length),
        });
        res.end(body);
      }
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => origin.close(() => resolve())));

  it("keeps an uncompressed response's content-length, so it can go inline", async () => {
    const response = (await createOriginProxyHandler(base)(request("/plain"))) as Response;
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("hello");
  });

  it("drops content-length and content-encoding once fetch has decompressed", async () => {
    const response = (await createOriginProxyHandler(base)(request("/gz"))) as Response;
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe("hello, compressed");
  });
});

