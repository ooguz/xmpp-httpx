import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpxFetch } from "../../src/client/fetch.js";
import { parseConfig } from "../../src/cli/config.js";
import { startGateway, type RunningGateway } from "../../src/cli/gateway.js";
import { connectUser, type E2eClient } from "./e2e-env.js";

/**
 * The gateway CLI fronting a real HTTP origin over real XMPP: config → session
 * → HttpxServer → origin proxy. `startGateway` is used directly rather than
 * spawning `bin/xmpp-httpx-gateway.mjs` so the suite needs no build; the bin is
 * a three-line shebang wrapper around the same module.
 */

const ORIGIN_PORT = 18081;
const METRICS_PORT = 19100;
const GATEWAY_JID = "httpx.localhost";

describe("gateway CLI serving an HTTP origin", () => {
  let origin: Server;
  let gateway: RunningGateway;
  let alice: E2eClient;
  let bob: E2eClient;
  /** What the origin saw, so header forwarding can be asserted. */
  const seen: { url: string; from: string | undefined; method: string }[] = [];

  beforeAll(async () => {
    origin = createServer((req, res) => {
      seen.push({
        url: req.url ?? "",
        from: req.headers["x-httpx-from"] as string | undefined,
        method: req.method ?? "",
      });
      if (req.url === "/hello") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>from the origin</h1>");
      } else if (req.url === "/echo" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(`echo:${Buffer.concat(chunks).toString("utf8")}`);
        });
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => origin.listen(ORIGIN_PORT, resolve));

    // Exactly what a user would type, parsed by the real CLI parser.
    const parsed = parseConfig({
      argv: [
        "--origin",
        `http://localhost:${ORIGIN_PORT}`,
        "--service",
        "xmpp://localhost:15347",
        "--domain",
        GATEWAY_JID,
        "--allow",
        "alice@localhost",
        "--metrics-port",
        String(METRICS_PORT),
        "--quiet",
      ],
      env: { XMPP_HTTPX_SECRET: "e2e-secret" },
    });
    if (parsed.kind !== "config") {
      throw new Error(`config rejected: ${JSON.stringify(parsed)}`);
    }

    gateway = await startGateway(parsed.config, {
      info: () => {},
      error: (message, err) => console.error("[cli-e2e]", message, err),
      request: () => {},
    });

    alice = await connectUser("alice", "e2e-alice", "cli-allowed");
    bob = await connectUser("bob", "e2e-bob", "cli-denied");
  });

  afterAll(async () => {
    await alice?.stop();
    await bob?.stop();
    await gateway?.stop();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  it("serves the origin to an allowed JID", async () => {
    const response = await httpxFetch(`httpx://${GATEWAY_JID}/hello`, {
      session: alice.session,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("from the origin");
  });

  it("tells the origin who is asking", async () => {
    seen.length = 0;
    await (
      await httpxFetch(`httpx://${GATEWAY_JID}/hello`, { session: alice.session })
    ).text();
    expect(seen[0]?.from).toBe(alice.jid);
  });

  it("forwards the origin's status codes", async () => {
    const response = await httpxFetch(`httpx://${GATEWAY_JID}/missing`, {
      session: alice.session,
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("nope");
  });

  it("proxies a request body", async () => {
    const response = await httpxFetch(`httpx://${GATEWAY_JID}/echo`, {
      session: alice.session,
      method: "POST",
      body: new URLSearchParams({ note: "über" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("echo:note=%C3%BCber");
  });

  it("exposes Prometheus metrics for the traffic it served", async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.metricsPort!}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("httpx_gateway_stream_up 1");
    expect(body).toMatch(
      /httpx_gateway_requests_total\{method="GET",status="200"\} [1-9]/,
    );
    expect(body).toContain('httpx_gateway_requests_total{method="GET",status="404"} 1');
    expect(body).toMatch(/httpx_gateway_request_duration_seconds_count [1-9]/);
  });

  it("reports itself healthy while the stream is up", async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.metricsPort!}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
  });

  it("refuses a JID that is not on the allowlist", async () => {
    seen.length = 0;
    await expect(
      httpxFetch(`httpx://${GATEWAY_JID}/hello`, { session: bob.session }),
    ).rejects.toMatchObject({ code: "forbidden", httpEquivalent: 403 });
    // The origin must never have been contacted for a refused requester.
    expect(seen).toEqual([]);

    const metrics = await (
      await fetch(`http://127.0.0.1:${gateway.metricsPort!}/metrics`)
    ).text();
    expect(metrics).toContain(
      'httpx_gateway_requests_denied_total{jid="bob@localhost"} 1',
    );
  });
});

describe("gateway CLI serving a directory (--static)", () => {
  let root: string;
  let gateway: RunningGateway;
  let alice: E2eClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "httpx-static-e2e-"));
    await writeFile(join(root, "index.html"), "<h1>static home</h1>");
    await writeFile(join(root, "note.txt"), "plain text");

    const parsed = parseConfig({
      argv: [
        "--static",
        root,
        "--service",
        "xmpp://localhost:15347",
        "--domain",
        GATEWAY_JID,
        "--allow-all",
        "--quiet",
      ],
      env: { XMPP_HTTPX_SECRET: "e2e-secret" },
    });
    if (parsed.kind !== "config") {
      throw new Error(`config rejected: ${JSON.stringify(parsed)}`);
    }
    gateway = await startGateway(parsed.config, {
      info: () => {},
      error: (message, err) => console.error("[static-e2e]", message, err),
      request: () => {},
    });
    alice = await connectUser("alice", "e2e-alice", "static-client");
  });

  afterAll(async () => {
    await alice?.stop();
    await gateway?.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("serves the directory index with no HTTP server involved", async () => {
    const response = await httpxFetch(`httpx://${GATEWAY_JID}/`, {
      session: alice.session,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("static home");
  });

  it("serves other files with their own type", async () => {
    const response = await httpxFetch(`httpx://${GATEWAY_JID}/note.txt`, {
      session: alice.session,
    });
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("plain text");
  });

  it("revalidates with a real 304 over the wire", async () => {
    const first = await httpxFetch(`httpx://${GATEWAY_JID}/`, {
      session: alice.session,
    });
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    await first.text();

    const revalidated = await httpxFetch(`httpx://${GATEWAY_JID}/`, {
      session: alice.session,
      headers: { "if-none-match": etag },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  it("404s a missing file and never escapes the root", async () => {
    const missing = await httpxFetch(`httpx://${GATEWAY_JID}/nope.html`, {
      session: alice.session,
    });
    expect(missing.status).toBe(404);
    await missing.text();

    const traversal = await httpxFetch(`httpx://${GATEWAY_JID}/../../etc/passwd`, {
      session: alice.session,
    });
    expect([403, 404]).toContain(traversal.status);
    expect(await traversal.text()).not.toContain("root:");
  });
});

describe("gateway CLI rate limiting (--rate)", () => {
  let root: string;
  let gateway: RunningGateway;
  let alice: E2eClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "httpx-rate-e2e-"));
    await writeFile(join(root, "index.html"), "<h1>rate limited site</h1>");

    const parsed = parseConfig({
      argv: [
        "--static",
        root,
        "--service",
        "xmpp://localhost:15347",
        "--domain",
        GATEWAY_JID,
        "--allow-all",
        "--rate",
        "1",
        "--burst",
        "2",
        "--metrics-port",
        String(METRICS_PORT + 1),
        "--quiet",
      ],
      env: { XMPP_HTTPX_SECRET: "e2e-secret" },
    });
    if (parsed.kind !== "config") {
      throw new Error(`config rejected: ${JSON.stringify(parsed)}`);
    }
    gateway = await startGateway(parsed.config, {
      info: () => {},
      error: () => {}, // refusals log at error level; expected here
      request: () => {},
    });
    alice = await connectUser("alice", "e2e-alice", "rate-client");
  });

  afterAll(async () => {
    await alice?.stop();
    await gateway?.stop();
    await rm(root, { recursive: true, force: true });
  });

  const get = () =>
    httpxFetch(`httpx://${GATEWAY_JID}/`, { session: alice.session });

  it("serves the burst, then answers 429 with Retry-After", async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 4; i++) {
      const response = await get();
      statuses.push(response.status);
      if (response.status === 429) retryAfter = response.headers.get("retry-after");
      await response.text();
    }

    // burst=2 at 1/s: the first two pass, the rest are refused (the whole
    // exchange takes far less than the second it would take to refill).
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.slice(2)).toEqual([429, 429]);
    expect(retryAfter).toBe("1");
  });

  it("lets the client back in once a token has refilled", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("rate limited site");
  });

  it("counts the refusals in its metrics", async () => {
    const body = await (
      await fetch(`http://127.0.0.1:${gateway.metricsPort!}/metrics`)
    ).text();
    expect(body).toMatch(
      /httpx_gateway_rate_limited_total\{jid="alice@localhost"\} [1-9]/,
    );
    // A 429 is a response like any other, so it lands in the usual counter too.
    expect(body).toMatch(/httpx_gateway_requests_total\{method="GET",status="429"\} [1-9]/);
  });
});
