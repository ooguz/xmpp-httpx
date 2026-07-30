import { createServer, type Server } from "node:http";
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

  it("refuses a JID that is not on the allowlist", async () => {
    seen.length = 0;
    await expect(
      httpxFetch(`httpx://${GATEWAY_JID}/hello`, { session: bob.session }),
    ).rejects.toMatchObject({ code: "forbidden", httpEquivalent: 403 });
    // The origin must never have been contacted for a refused requester.
    expect(seen).toEqual([]);
  });
});
