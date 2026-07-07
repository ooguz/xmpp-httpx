# xmpp-httpx

TypeScript implementation of [XEP-0332: HTTP over XMPP Transport](https://xmpp.org/extensions/xep-0332.html) — tunnel HTTP requests and responses through XMPP, for Node.js and browsers.

XEP-0332 is a **Deferred** XEP (v0.5.1). This library is an exploratory implementation of the kind the XEP explicitly encourages, built as the foundation for a browser that navigates `httpx://user@domain/path` URLs. Deliberate deviations and interpretations of underspecified areas are documented in [docs/protocol-notes.md](docs/protocol-notes.md).

## What's implemented

- **Requester (client) and responder (server)** sides of the protocol
- **All seven body transports** of the XEP: inline `text` / `xml` / `base64`, `chunkedBase64` message streams, **IBB** ([XEP-0047](https://xmpp.org/extensions/xep-0047.html), implemented here — no upstream xmpp.js package exists), **sipub** ([XEP-0137](https://xmpp.org/extensions/xep-0137.html) over SI, IBB stream method), and a minimal **Jingle** session ([XEP-0166](https://xmpp.org/extensions/xep-0166.html)/[0234](https://xmpp.org/extensions/xep-0234.html) over the [XEP-0261](https://xmpp.org/extensions/xep-0261.html) IBB transport). sipub/jingle are opt-in for sending (`preferredStreams`), always accepted on receive
- SHIM headers ([XEP-0131](https://xmpp.org/extensions/xep-0131.html)), `httpx://` URL parsing, service discovery ([XEP-0030](https://xmpp.org/extensions/xep-0030.html)), entity caps ([XEP-0115](https://xmpp.org/extensions/xep-0115.html)) with presence-based capability caching
- A `fetch()`-shaped API returning real WHATWG `Response` objects with streaming bodies
- A reverse-proxy handler for gateway deployments (`xmpp-httpx/node`)

## Install

```sh
npm install xmpp-httpx @xmpp/client
```

ESM-only, Node ≥ 20.10 or any evergreen browser. `@xmpp/client` (or `@xmpp/component`) is a peer dependency — this library never opens connections; you hand it a connected session.

## Client

```js
import { client, xml } from "@xmpp/client";
import { HttpxClient, httpxFetch } from "xmpp-httpx";

const xmpp = client({ service: "wss://example.org/xmpp-websocket", username: "alice", password: "…" });
await xmpp.start();

// fetch()-style — returns a WHATWG Response
const response = await httpxFetch("httpx://webserver@example.org/index.html", {
  session: xmpp,
});
console.log(response.status, await response.text());

// Lower-level API with full control
const httpx = new HttpxClient(xmpp, { maxChunkSize: 4096 });
const resp = await httpx.request("webserver@example.org", {
  method: "POST",
  resource: "/api/items",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "thing" }),
});
console.log(resp.statusCode, await resp.json());
```

Response bodies are `ReadableStream<Uint8Array>` — large bodies stream progressively regardless of which mechanism (inline, chunked messages, IBB) carried them. XMPP-level failures (forbidden, timeout, unreachable) throw `HttpxError` with an `httpEquivalent` status; only real `<resp>` stanzas produce responses.

## Server

```js
import { HttpxServer, allowList } from "xmpp-httpx";

const server = new HttpxServer(xmpp, {
  authorize: allowList(["alice@example.org", "*@trusted.example"]),
});

server.handle(async (req) => {
  // req: { from, to, method, resource, url, headers, body, accept }
  if (req.resource === "/hello") {
    return { status: 200, headers: { "content-type": "text/plain" }, body: "hi" };
  }
  // WHATWG Responses work directly — reverse-proxying is one line:
  return fetch(new URL(req.resource, "http://localhost:8080"));
});

server.start();
```

Authorization is **deny-all by default** per the XEP's security considerations — pass `allowAll()`, `allowList(...)`, or your own policy. The server picks the response encoding automatically: small bodies inline into the IQ, large ones stream via IBB or chunked messages, honoring the requester's advertised `maxChunkSize` and mechanism flags.

For gateway deployments (an XMPP component fronting a real web server):

```js
import { component } from "@xmpp/component";
import { HttpxServer, allowAll } from "xmpp-httpx";
import { createOriginProxyHandler } from "xmpp-httpx/node";

const gw = component({ service: "xmpp://localhost:5347", domain: "web.example.org", password: "…" });
const server = new HttpxServer(gw, { authorize: allowAll() });
server.handle(createOriginProxyHandler("http://localhost:8080"));
server.start();
```

## Development

```sh
npm install
npm run lint && npm run typecheck   # ESLint + tsc
npm test                            # vitest: unit + in-memory integration suite
npm run build                       # emit dist/
```

The integration suite runs both endpoints against an in-memory stanza router (`test/integration/mock-session.ts`) with fault injection (reordered chunk delivery), so the full protocol — including IBB flow control — is exercised without a real XMPP server.

## Roadmap

- v0.2/0.3 features (chunked + IBB) are already in; next: entity caps (XEP-0115), sipub (XEP-0137), Jingle transport
- Dockerized Prosody E2E suite and vitest browser-mode CI
- The `httpx://` browser integration, as a separate package consuming `xmpp-httpx/client`

## License

AGPL-3.0-only
