# xmpp-httpx

[![CI](https://github.com/ooguz/xmpp-httpx/actions/workflows/ci.yml/badge.svg)](https://github.com/ooguz/xmpp-httpx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/xmpp-httpx)](https://www.npmjs.com/package/xmpp-httpx)
[![API docs](https://img.shields.io/badge/API-typedoc-blue)](https://ooguz.github.io/xmpp-httpx/)

TypeScript implementation of [XEP-0332: HTTP over XMPP Transport](https://xmpp.org/extensions/xep-0332.html) — tunnel HTTP requests and responses through XMPP, for Node.js and browsers.

*[Türkçe belge: README.tr.md](README.tr.md)*

XEP-0332 is a **Deferred** XEP (v0.5.1). This library is an exploratory implementation of the kind the XEP explicitly encourages, built as the foundation for a browser that navigates `httpx://user@domain/path` URLs.

**Documentation:**

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Design rules, module map, request lifecycle, all seven transports, error & security models, configuration reference |
| [docs/protocol-notes.md](docs/protocol-notes.md) | Every decision made where the spec is ambiguous — the interop anchor |
| [docs/testing.md](docs/testing.md) | The three vitest projects, mock-session harness, Prosody E2E, CI |
| [docs/browser-extension.md](docs/browser-extension.md) | WebExtension architecture: connection placement, rendering pipeline, tabs, manifest strategy |
| [docs/electron-shell.md](docs/electron-shell.md) | The desktop shell: `httpx://` as a scheme Chromium fetches, and why that changes the design |
| [docs/gateway-cli.md](docs/gateway-cli.md) | `xmpp-httpx-gateway`: put an existing HTTP origin on XMPP, by hand or in Docker |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Next phases and tasks (release, hardening, extension v2, gateway product) |
| [docs/xep-0332-feedback.md](docs/xep-0332-feedback.md) | Implementation-experience write-up for the XSF standards process |
| [docs/interop.md](docs/interop.md) | Interoperability matrix — tested servers, runtimes, peer implementations |
| [examples/webext/README.md](examples/webext/README.md) | Build/run guide for the browser extension |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## What's implemented

- **Requester (client) and responder (server)** sides of the protocol
- **All seven body transports** of the XEP: inline `text` / `xml` / `base64`, `chunkedBase64` message streams, **IBB** ([XEP-0047](https://xmpp.org/extensions/xep-0047.html), implemented here — no upstream xmpp.js package exists), **sipub** ([XEP-0137](https://xmpp.org/extensions/xep-0137.html) over SI, IBB stream method), and a minimal **Jingle** session ([XEP-0166](https://xmpp.org/extensions/xep-0166.html)/[0234](https://xmpp.org/extensions/xep-0234.html) over the [XEP-0261](https://xmpp.org/extensions/xep-0261.html) IBB transport). sipub/jingle are opt-in for sending (`preferredStreams`), always accepted on receive
- SHIM headers ([XEP-0131](https://xmpp.org/extensions/xep-0131.html)), `httpx://` URL parsing, service discovery ([XEP-0030](https://xmpp.org/extensions/xep-0030.html)), entity caps ([XEP-0115](https://xmpp.org/extensions/xep-0115.html)) with presence-based capability caching
- A `fetch()`-shaped API returning real WHATWG `Response` objects with streaming bodies
- A reverse-proxy handler for gateway deployments (`xmpp-httpx/node`)
- A ready-made gateway CLI (`xmpp-httpx-gateway`) with a Docker image
- A published test harness (`xmpp-httpx/testing`) so downstream code can be tested without an XMPP server

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

Response bodies are `ReadableStream<Uint8Array>` — large bodies stream progressively regardless of which mechanism (inline, chunked messages, IBB) carried them, and `.text()`, `.json()`, `.bytes()`, `.xml()` and `.formData()` are all there. XMPP-level failures (forbidden, timeout, unreachable) throw `HttpxError` with an `httpEquivalent` status; only real `<resp>` stanzas produce responses.

Per request you can set `timeoutMs` (the IQ deadline), `idleTimeoutMs` (the gap allowed between pieces of a streamed body), and a `signal` — `AbortSignal.timeout(5000)` is all a caller needs for an overall deadline.

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

Authorization is **deny-all by default** per the XEP's security considerations — pass `allowAll()`, `allowList(...)`, or your own policy. `withRateLimit(handler, { ratePerSecond })` throttles per requester, and `negotiateContentType(req.headers.get("accept"), ["text/html", "application/json"])` picks a representation without getting q-values wrong. The server picks the response encoding automatically: small bodies inline into the IQ, large ones stream via IBB or chunked messages, honoring the requester's advertised `maxChunkSize` and mechanism flags.

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

## Gateway CLI

Put an existing website on XMPP without writing any code:

```sh
XMPP_HTTPX_SECRET=… npx xmpp-httpx-gateway \
  --origin http://localhost:8080 \
  --service xmpp://xmpp.example.org:5347 \
  --domain web.example.org \
  --allow alice@example.org
```

That serves `httpx://web.example.org/…` from your HTTP origin, forwarding each
requester's SASL-authenticated JID as `X-Httpx-From`. Client-account mode
(`--jid`/`--password`) needs no server-side configuration at all. Authorization
is never implicit: `--allow <jid>` or `--allow-all`, or the gateway refuses to
start. Everything can live in a JSON config file (`--config`), with
flags > environment > file precedence. See
[docs/gateway-cli.md](docs/gateway-cli.md).

`--static <dir>` serves a directory with no HTTP origin at all; `--rate`/`--burst`
throttle per requester (a real 429 with `Retry-After`); `--metrics-port` exposes
Prometheus metrics and a `/healthz` probe.

For a deployment, [`examples/docker/`](examples/docker/) is a three-container
stack — nginx origin, Prosody, gateway — that goes from `docker compose up` to a
browsable `httpx://web.localhost/` in two commands.

## Development

```sh
npm install
npm run lint && npm run typecheck   # ESLint + tsc
npm test                            # vitest: unit + in-memory integration suite
npm run build                       # emit dist/
npm run demo                        # Prosody + demo site, one command
```

The integration suite runs both endpoints against an in-memory stanza router with fault injection (reordered chunk delivery), so the full protocol — including IBB flow control — is exercised without a real XMPP server. That harness is published as **`xmpp-httpx/testing`**, so your own handlers can be tested the same way:

```js
import { createSessionPair } from "xmpp-httpx/testing";

const [clientSession, serverSession] = createSessionPair("alice@example.org/pc", "web@example.org");
// …put an HttpxServer on one, an HttpxClient on the other, and assert.
```

## The browser

[`examples/webext/`](examples/webext/) is a working **WebExtension for Firefox and Chromium** that navigates `httpx://` URLs with this library: tabs with per-tab history, an address bar, a history/bookmarks drawer, an omnibox keyword (`httpx server@example.org/page` ⏎), clickable `ext+httpx://` links on Firefox, and a sanitized rendering pipeline (DOMPurify + a CSSOM CSS sanitizer → blob-URL subresources → script-less sandboxed iframe) with forms, downloads, page titles/favicons and an HTTP cache doing real 304 revalidation. See its README for build/run instructions, `scripts/demo-gateway.mjs` for a demo site to browse, and `npm run smoke` to drive the whole thing in real Chromium.

## The desktop shell

[`examples/electron/`](examples/electron/) goes further than the extension can:
`protocol.handle("httpx", …)` makes `httpx://` a scheme **Chromium itself
fetches**, so the address bar is real and subresources, forms, history and
downloads work as they do for http — no blob-URL rewriting anywhere.

```sh
cd examples/electron && npm install && npm start
```

Page scripts are off by default (a CSP the protocol handler imposes over the
server's), content lives in sandboxed views with no preload, and account JIDs are
encoded into the host because a `Request` URL cannot carry credentials. See
[docs/electron-shell.md](docs/electron-shell.md).

## Roadmap

Done so far: the protocol with all seven transports, the browser extension, the
gateway (CLI, Docker image, metrics, static-site mode, rate limiting) and the
desktop shell. Next:

- Jingle S5B (XEP-0260) transport candidate negotiation
- Packaging the shell, which is what an OS-level `httpx:` registration needs
- Publishing to npm and the extension stores

Full detail, including everything already finished, in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

AGPL-3.0-only
