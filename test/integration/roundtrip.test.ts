import xml from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { NS_DISCO_INFO, NS_HTTPX } from "../../src/constants.js";
import { decodeResp } from "../../src/codec/resp.js";
import { HttpxError } from "../../src/errors.js";
import { allowAll, denyAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  type HttpxHandler,
  type HttpxServerOptions,
} from "../../src/server/server.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { createSessionPair, MockSession } from "./mock-session.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function setup(
  handler?: HttpxHandler,
  serverOptions: HttpxServerOptions = {},
  clientOptions: ConstructorParameters<typeof HttpxClient>[1] = {},
) {
  const [clientSession, serverSession] = createSessionPair();
  const server = new HttpxServer(serverSession, {
    authorize: allowAll(),
    ...serverOptions,
  });
  if (handler) server.handle(handler);
  server.start();
  const client = new HttpxClient(clientSession, clientOptions);
  cleanups.push(async () => {
    await client.close();
    server.stop();
  });
  return { client, server, clientSession, serverSession };
}

describe("inline round-trips", () => {
  it("GET with an inline text response", async () => {
    let seen: { method: string; resource: string; host: string | null } | undefined;
    const { client } = setup((req) => {
      seen = {
        method: req.method,
        resource: req.resource,
        host: req.headers.get("host"),
      };
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "hello world",
      };
    });

    const resp = await client.request("server@example.org", {
      resource: "/greeting?lang=en",
      headers: { host: "example.org" },
    });

    expect(seen).toEqual({
      method: "GET",
      resource: "/greeting?lang=en",
      host: "example.org",
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.statusMessage).toBe("OK");
    expect(await resp.text()).toBe("hello world");
  });

  it("POST body echo through inline encoding", async () => {
    const { client } = setup(async (req) => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `echo:${req.body ? new TextDecoder().decode(await bytesFromStream(req.body)) : ""}`,
    }));

    const resp = await client.request("server@example.org", {
      method: "POST",
      resource: "/echo",
      body: "ping",
    });
    expect(await resp.text()).toBe("echo:ping");
  });

  it("handler may return a WHATWG Response", async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json" },
        }),
    );
    const resp = await client.request("server@example.org", {
      method: "POST",
      resource: "/things",
    });
    expect(resp.statusCode).toBe(201);
    expect(resp.statusMessage).toBe("Created");
    expect(await resp.json()).toEqual({ ok: true });
  });

  it("XML bodies round-trip via <data><xml>", async () => {
    const payload = xml(
      "sparql",
      { xmlns: "http://www.w3.org/2005/sparql-results#" },
      xml("head", null, xml("variable", { name: "title" })),
    );
    const { client } = setup(() => ({ status: 200, body: payload }));
    const resp = await client.request("server@example.org", { resource: "/q" });
    const element = await resp.xml();
    expect(element?.getName()).toBe("sparql");
    expect(element?.getChild("head")?.getChild("variable")?.attrs["name"]).toBe(
      "title",
    );
  });

  it("HTTP error statuses pass through as responses, not exceptions", async () => {
    const { client } = setup(() => ({ status: 404, statusMessage: "Not Found" }));
    const resp = await client.request("server@example.org", { resource: "/nope" });
    expect(resp.statusCode).toBe(404);
    expect(resp.ok).toBe(false);
    expect(resp.body).toBeNull();
  });
});

describe("failure mapping", () => {
  it("a throwing handler becomes HTTP 500", async () => {
    const { client } = setup(() => {
      throw new Error("boom");
    });
    const resp = await client.request("server@example.org", {});
    expect(resp.statusCode).toBe(500);
  });

  it("authorization denial becomes an XMPP forbidden error → HttpxError 403", async () => {
    const { client } = setup(() => ({ status: 200 }), { authorize: denyAll() });
    const err = await client
      .request("server@example.org", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).code).toBe("forbidden");
    expect((err as HttpxError).httpEquivalent).toBe(403);
  });

  it("a server with no handler answers 501", async () => {
    const { client } = setup();
    const resp = await client.request("server@example.org", {});
    expect(resp.statusCode).toBe(501);
  });

  it("an unresponsive server maps to a timeout HttpxError", async () => {
    const { client } = setup(() => new Promise(() => {}));
    const err = await client
      .request("server@example.org", { timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).code).toBe("timeout");
  });

  it("an already-aborted signal rejects immediately", async () => {
    const { client } = setup(() => ({ status: 200 }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request("server@example.org", { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("explicit disco without urn:xmpp:http → not-implemented", async () => {
    const [clientSession, serverSession] = createSessionPair();
    // A disco responder that does NOT advertise urn:xmpp:http.
    serverSession.iqCallee.get(NS_DISCO_INFO, "query", () =>
      xml("query", { xmlns: NS_DISCO_INFO }, xml("feature", { var: "jabber:iq:version" })),
    );
    const client = new HttpxClient(clientSession);
    cleanups.push(() => client.close());

    const err = await client
      .request("server@example.org", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).code).toBe("not-implemented");
  });

  it("unsupported request data mechanisms are answered with HTTP 501", async () => {
    const { clientSession } = setup(() => ({ status: 200 }));
    const iq = xml(
      "iq",
      { type: "set", to: "server@example.org" },
      xml(
        "req",
        { xmlns: NS_HTTPX, method: "POST", resource: "/", version: "1.1" },
        xml("data", null, xml("carrier-pigeon", { xmlns: "urn:example:rfc1149" })),
      ),
    );
    const result = await clientSession.iqCaller.request(iq, 1000);
    const resp = decodeResp(result.getChild("resp", NS_HTTPX)!);
    expect(resp.statusCode).toBe(501);
  });

  it("oversized inline request bodies are answered with HTTP 413", async () => {
    const { client } = setup(() => ({ status: 200 }), {
      maxRequestBodyBytes: 10,
    });
    const resp = await client.request("server@example.org", {
      method: "POST",
      body: "x".repeat(100),
    });
    expect(resp.statusCode).toBe(413);
  });
});

describe("component-style addressing", () => {
  it("keys replies and requests by the addressed JID", async () => {
    const clientSession = new MockSession("client@example.org/browser");
    const gatewaySession = new MockSession("gateway.example.org");
    clientSession.peer = gatewaySession;
    gatewaySession.peer = clientSession;

    let seenTo: string | undefined;
    const server = new HttpxServer(gatewaySession, { authorize: allowAll() });
    server.handle((req) => {
      seenTo = req.to;
      return { status: 200, body: `host:${req.to}` };
    });
    server.start();
    const client = new HttpxClient(clientSession);
    cleanups.push(async () => {
      await client.close();
      server.stop();
    });

    const resp = await client.request("web@gateway.example.org", {
      resource: "/",
    });
    expect(resp.statusCode).toBe(200);
    expect(seenTo).toBe("web@gateway.example.org");
    expect(await resp.text()).toBe("host:web@gateway.example.org");
  });
});
