# Changelog

## Unreleased

- **Gateway CLI**: `xmpp-httpx-gateway`, shipped as a `bin` of this package.
  Fronts an HTTP origin over XMPP in component or client mode, with a JSON
  config file, explicit `--allow`/`--allow-all` authorization (start is refused
  without one), stanza budgets, stream preference, request logging and clean
  signal shutdown. Secrets come from `XMPP_HTTPX_SECRET`/`XMPP_HTTPX_PASSWORD`.
  See [docs/gateway-cli.md](docs/gateway-cli.md).
- **Docker image** for the gateway (`Dockerfile`), plus a runnable
  three-container compose example in `examples/docker/` (nginx origin + Prosody
  + gateway). The runtime stage installs the `npm pack` tarball, so the image
  runs exactly what would be published.
- **`isStreamMechanism(value)`** exported — the guard the CLI needs to validate
  `--prefer`, useful to anyone else narrowing user input to a mechanism.

Packaging/tooling fixes —

- **`npm run build` and `npm run lint` were broken** and would have failed CI:
  `tsconfig.build.json` never saw the Node types `src/node/socks5.ts` needs
  (they reached `npm run typecheck` only via vitest's config types), and
  `scripts/memcheck.mjs` had unused imports plus globals missing from the
  eslint scripts override. Both fixed; `docs/api/` is now eslint-ignored so a
  local `npm run docs:api` doesn't make lint diverge from CI.

The bundled example browser (`examples/webext/`, not published to npm) gained
page CSS, forms, caching, downloads, and page metadata — see
[docs/ROADMAP.md](docs/ROADMAP.md) phase 10 and
[docs/browser-extension.md](docs/browser-extension.md).

## 0.6.0 — 2026-07-07

- **Content-Encoding**: transparent gzip/deflate via
  CompressionStream/DecompressionStream (browser-safe). Client advertises
  `Accept-Encoding` and decompresses responses; server compresses
  compressible responses (eagerly for byte bodies — a gzipped body often
  fits inline) and decompresses pre-encoded request bodies, with a
  post-decompression cap against zip bombs. Disable with `compress: false`
  on either side.
- **`stanzaBudgets(maxStanzaBytes)`** derives `inlineBudgetBytes` +
  `maxChunkSize` from a known server stanza limit; an explicitly advertised
  `maxChunkSize` is now honored up to the spec maximum (previously capped
  at 8192).
- **Authorization policy helpers**: `presencePolicy(session)` (allow
  currently-available JIDs) and `manualPolicy(prompt, {ttlMs})`
  (application-approved requesters with per-JID caching).
- **Origin proxy** forwards the requester's full XMPP-authenticated JID as
  `X-Httpx-From` (configurable/disable via `jidHeader`) — the httpx
  replacement for cookies/Basic auth.
- Documented sessions/reconnection/stream-lifetime semantics and the
  authentication model in `docs/architecture.md`; connection loss
  mid-stream is tested to surface as a `timeout` error.

## 0.5.0 — 2026-07-07

- **sipub transport** (XEP-0137 over XEP-0095 SI, IBB stream method only):
  one-shot publications bound to the requester's bare JID, 60 s TTL.
- **Jingle transport** (minimal XEP-0166 subset: XEP-0234 file-transfer
  description over the XEP-0261 IBB transport; the initiate embedded in
  <data> is the session-initiate — see docs/protocol-notes.md).
  All seven XEP-0332 data mechanisms are now implemented.
- **XEP-0115 entity caps**: `computeCapsVer`/`buildCapsElement`, and
  DiscoCache now learns capabilities passively from presence, verifying
  each ver hash with a single disco query.
- Client `accept` option gains `sipub`/`jingle` flags (default true);
  `preferredStreams` accepts `"sipub"`/`"jingle"` on both sides.
- BodyTransport registry is now bidirectional (offer/receive) — the
  extension point custom transports plug into.

## 0.4.0 — 2026-07-07

First feature-complete release of the v0.1–v0.4 roadmap. No published
versions precede this; earlier numbers below describe the internal
milestones folded into it.

### v0.4 — hardening
- AbortSignal now tears down streaming response bodies (chunkedBase64
  reassembly errors immediately; unread IBB bodies are cancelled and the
  peer notified with `<close/>`).
- Streamed-request-body failures are always surfaced as `HttpxError`.
- Dockerized Prosody E2E suite (`npm run test:e2e`, Docker required):
  real c2s round-trips over WebSocket and a component gateway serving a
  demo site.
- Unit + integration suites also run in headless Chromium
  (`npm run test:browser`) — the whole protocol stack is exercised in a
  real browser environment.

### v0.3 — IBB
- XEP-0047 In-Band Bytestreams, both directions, with IQ-ack flow control;
  preferred mechanism for large bodies.

### v0.2 — chunkedBase64
- Chunked message streams with out-of-order reassembly, idle timeouts,
  buffer caps, and orphan-chunk buffering.

### v0.1 — core
- XEP-0332 stanza codec (req/resp/SHIM headers/data) validated against the
  XEP's examples; inline text/xml/base64 bodies.
- `HttpxClient`, `httpxFetch()` (WHATWG Response bridge), `HttpxServer`
  with deny-by-default authorization policies, XEP-0030 discovery,
  `httpx://` URL parsing, Node reverse-proxy handler (`xmpp-httpx/node`).
