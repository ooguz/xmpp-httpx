# Changelog

## Unreleased

- **WebExtension embedded mode**: `browser.html?embedded=1` hides the
  extension's own tab strip and URL bar, for a host app that provides its own
  browser chrome — built for the Firefox Klar fork, where the page runs as a
  GeckoView built-in extension behind the app's real toolbar. The flag is read
  once at boot (the page rewrites its visible URL while navigating), and the
  empty-tab `replaceState` now preserves the query string.
- **Embedded mode drives the host's back button**: standalone, the page's own
  per-tab stacks are the history and every URL-mirror write replaces; embedded,
  those controls are hidden, so a page-to-page navigation now *pushes* a
  session-history entry and a host back/forward traversal (arriving as
  `hashchange`) reloads the page it lands on. The boot-time upgrade of the
  empty-tab entry still replaces, so the first page stays the only entry and
  the host's back on it leaves the app rather than landing on a blank tab.
  Hardening that came out of adversarially reviewing this change (two rounds):
  - Tab URLs are canonicalized to the WHATWG-*serialized* spelling when
    visited, and the URL mirror compares that spelling — `location.hash` reads
    back percent-encoded, so a raw space or non-ASCII character in the tab URL
    used to look like a permanently pending write (embedded, that pushed
    duplicate entries on every load) and made a traversal re-enter the page
    under a different identity: duplicate stack entries, guaranteed cache
    misses, and a different wire resource than the original visit.
  - Only a real URL change pushes. A re-spelling of the current page's hash —
    hand-edited or typed `#httpx://host` landing on the canonical
    `#httpx://host/` — replaces: pushing there left a duplicate entry behind
    every typo, and let one non-canonical entry re-push the canonical one on
    every host back press, an inescapable back-button trap.
  - A load superseded by a newer one on the same tab now bails out instead of
    rendering: a slow fetch that lost the race could paint its page *after*
    the winner, leaving the iframe showing one page and the URL another. The
    cache chip takes the superseded fetch's state no more, and a tab close
    mid-load waits for *all* in-flight loads before detaching.
  - Traversals never re-save attachments. History re-entry — the host's
    back/forward, the page's own buttons — renders the file's receipt with a
    "Download" button instead of saving with no user gesture; a *fresh*
    navigation to an attachment (a URL typed into the host's toolbar arrives
    as hashchange too, distinguished by whether the spelling is one the page
    itself mirrored) still saves immediately.
  - An unparseable typed URL takes a history entry of its own (like a
    browser's error page), so walking back over it stays consistent instead
    of leaving two identical adjacent entries and a dead back press.
  - A URL typed while the boot auto-connect was still in flight is no longer
    overridden by the boot hash once the connection comes up.
- **WebExtension fix**: `normalizeUrl` no longer percent-decodes every
  navigated URL — only inputs that arrive wholly encoded are decoded: the
  Firefox protocol-handler `%s` placeholder (`ext+httpx://…`) and the
  background script's omnibox deep link (`#httpx%3A%2F%2F…`). Decoding
  already-encoded URLs from links and GET forms corrupted them: `%23` in a
  form value became `#` and silently truncated the query, `%26` became `&`
  and split parameters.
- **WebExtension fix**: the history/bookmarks drawer was always visible — its
  `#drawer { display: flex }` rule outweighed the UA's `[hidden]` rule, so
  closing it never actually hid it. An explicit `#drawer[hidden]` rule restores
  the intended behavior.

## 0.7.0 — 2026-08-27

- **Gateway CLI**: `xmpp-httpx-gateway`, shipped as a `bin` of this package.
  Fronts an HTTP origin over XMPP in component or client mode, with a JSON
  config file, explicit `--allow`/`--allow-all` authorization (start is refused
  without one), stanza budgets, stream preference, request logging and clean
  signal shutdown. Secrets come from `XMPP_HTTPX_SECRET`/`XMPP_HTTPX_PASSWORD`.
  See [docs/gateway-cli.md](docs/gateway-cli.md).
- **Two latent SOCKS5 data-loss bugs fixed**, both found by exercising the read
  direction of a dialled connection: the handshake reader buffered bytes that
  shared a TCP segment with the CONNECT reply and then dropped them, and
  detaching that reader left the socket in flowing mode, where Node *discards*
  incoming data until the next listener attaches. Either could silently truncate
  a body on the existing XEP-0065 retriever path; the second showed up as a test
  failing one run in three.
- **`Socks5Adapter` is now role-neutral**: `connect()` and `openChosen()` (renamed
  from `openOutgoing`) both return `{ readable, out }`, so either party can read
  or write over a bytestream whichever way it was established. Breaking change
  for anyone implementing the adapter interface.
- **XEP-0260 (Jingle SOCKS5 Bytestreams)**, end to end: candidate/transport
  codec, transport-info payloads, priority arithmetic, `dstaddr`, the §2.4
  negotiation reconciliation (all exported), and the `JingleManager` wiring —
  candidates in a `transport-info` from *both* sides, `candidate-used`/
  `candidate-error`, proxy activation, and `transport-replace` to IBB when no
  candidate is usable. A sender that cannot host reaches a receiver that can, by
  dialling out. Active
  when a `Socks5Adapter` is supplied; IBB otherwise, so browser clients are
  unaffected. **Behaviour change:** a jingle offer carrying an s5b transport is
  now accepted (and falls back to IBB if necessary) rather than declined with
  `not-implemented`.
- **Desktop shell** (`examples/electron/`): `httpx://` registered as a real
  scheme via `protocol.handle`, so Chromium fetches pages *and subresources*
  itself. Not published to npm — an example, like the WebExtension.
- **`xmpp-httpx/testing`**: the in-memory session-pair harness this library's own
  integration suite runs on is now a published subpath (`createSessionPair`,
  `MockSession`, and the `deliverHook` fault-injection seam), so downstream
  handlers and clients can be tested without an XMPP server.
- **`HttpxResponse.formData()`** (urlencoded and multipart, via the platform's
  own parser), and **`parseAccept`/`negotiateContentType`** for content
  negotiation.
- **Per-request `idleTimeoutMs`** on `HttpxClient.request` and `httpxFetch`,
  overriding the client-wide default for one streamed body.
- **`npm run demo`**: Prosody, demo users and the demo site in one command.
- **`withRateLimit(handler, options)`**: per-bare-JID token bucket, exported from
  the library and wired to the CLI's `--rate`/`--burst`. Throttled requests get a
  real 429 with `Retry-After` (not a 403), and never reach the origin.
- **Static-site mode** for the gateway: `--static <dir>` serves a directory
  directly, with no HTTP origin — validators for cheap 304s, streamed bodies,
  and containment checked twice (lexically and against the real path, so a
  symlink cannot lead out of the root).
- **Gateway observability**: `--log-format json`, and `--metrics-port` serving
  Prometheus metrics plus a `/healthz` liveness endpoint (loopback-bound by
  default). Requests, denials and errors are counted; request duration is a
  histogram; `httpx_gateway_stream_up` reports XMPP connectivity.
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
