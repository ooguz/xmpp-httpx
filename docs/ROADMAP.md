# Roadmap — next possible phases and tasks

Status today (v0.5.0, 2026-07-07): the library implements **all seven
XEP-0332 body transports** with client + server, discovery + entity caps,
a Prosody E2E suite, browser-mode CI, and a working Firefox/Chromium
WebExtension browser (`examples/webext/`). Rounds 1–2 (phases 1–6) are done;
this file plans what comes after. Effort sizing: **S** ≤ half a day,
**M** ≈ 1–3 days, **L** ≈ a week+.

## Phase 7 — Release & ecosystem

Goal: make the library consumable and visible; XEP-0332 explicitly asks for
implementations to revive its standards process — be that implementation.

- [ ] **Publish `xmpp-httpx@0.5.0` to npm** (S) — needs the owner's npm
  auth; add `repository`/`homepage` once a public git remote exists;
  consider `npm publish --provenance` from CI.
- [ ] **Git remote + CI activation** (S) — push to a forge so the four CI
  jobs actually run; add a README badge.
- [ ] **API reference site** (M) — typedoc over the public exports,
  published via CI (GitHub Pages); the JSDoc is already written for this.
- [ ] **XSF / standards feedback** (M) — write up the implementation
  experience (everything in `docs/protocol-notes.md`: the jingle-in-`<data>`
  ambiguity, chunk-loss signaling gap, `maxChunkSize` units, request-body
  negotiation gap) and post to the XSF standards list proposing XEP-0332
  move back to Experimental with fixes.
- [ ] **Interop matrix page** (S) — document tested servers (Prosody 13) and
  invite reports against ejabberd/Openfire/Tigase.

Acceptance: package installable from npm; docs site live; feedback thread
opened.

## Phase 8 — Protocol completeness & interop

Goal: close the remaining spec-adjacent gaps.

- [ ] **Content-Encoding support** (M) — gzip/deflate request+response
  bodies via `CompressionStream`/`DecompressionStream` (browser-safe);
  negotiate with `Accept-Encoding`/`Content-Encoding` headers; big win since
  base64 already costs 33%.
- [ ] **XEP-0348 (Signing Forms / HTTP over XMPP auth patterns)** (M) —
  research + implement whatever request-authentication pattern fits httpx
  gateways; at minimum document JID-based auth as the replacement for
  cookies/basic-auth.
- [ ] **SOCKS5 bytestreams** (L) — XEP-0065 as an out-of-band data plane and
  XEP-0260 (Jingle S5B) as a Jingle transport, with IBB fallback. First
  transport that beats in-band throughput; Node-only initially (browser has
  no raw TCP).
- [ ] **Stanza-size probing** (S) — the 10 KiB floor is conservative; probe
  the server's real limit (XEP-0478 stream limits when advertised) and
  raise `inlineBudgetBytes`/chunk size accordingly.
- [ ] **Roster-policy helpers** (M) — the XEP's "manual" and "provisioned"
  authorization modes as optional helpers driven by presence-subscription
  events, without the library owning presence.
- [ ] **Reconnect resilience** (M) — today a dropped session kills in-flight
  streams (correct but blunt): document the story, surface a
  `session-replaced` hook, and test against XEP-0198 resumption (streams
  survive a resume; must not survive a new session).

Acceptance: compressed bodies round-trip in E2E; S5B beats IBB in the
benchmark (phase 9) on Node; protocol-notes updated per feature.

## Phase 9 — Hardening & performance

Goal: trust the implementation under adversarial and heavy load.

- [ ] **Codec fuzzing** (M) — fast-check arbitrary-XML fuzzing of
  `decodeReq`/`decodeResp`/chunk/IBB handlers: no crash, only
  `CodecError`/IQ-error outcomes.
- [ ] **Adversarial-peer suite** (M) — a hostile mock peer: chunk floods for
  unknown streams, sid collisions, seq desync, oversized blocks, withheld
  acks, early terminates — assert every bound in the security model holds.
- [ ] **Throughput benchmarks** (M) — bytes/sec per transport (inline vs
  chunked vs IBB vs S5B) over the mock pair and over Prosody; track in CI as
  an informational job; tune block sizes from data instead of folklore.
- [ ] **Memory audit** (S) — heap snapshots while streaming 100 MiB bodies;
  verify all paths stay O(chunk) not O(body).
- [ ] **Security review** (M) — run `/security-review` over the full tree;
  external eyes on the sandbox/rendering pipeline reasoning in the
  extension.

Acceptance: fuzz + adversarial suites green in CI; published benchmark
numbers; no O(body) memory paths.

## Phase 10 — Browser extension v2

Goal: from demo to daily-drivable.

- [ ] **Sanitized CSS subset** (L) — allow `<style>`/inline styles through a
  CSS sanitizer (strip `url()`, `@import`, expressions); biggest visible
  quality jump.
- [ ] **Progressive rendering** (M) — render HTML as it streams (the body is
  already a stream; today the extension buffers `text()` first).
- [ ] **Forms** (M) — GET/`application/x-www-form-urlencoded` POST forms
  (currently stripped); DOMPurify config + submit interception.
- [ ] **Caching** (M) — Cache API keyed by httpx URL honoring
  `Cache-Control`/`ETag`, with `If-None-Match` revalidation → real 304 flow
  end-to-end.
- [ ] **Tab strip + history UI** (M) — multiple pages per window, a
  history/bookmarks drawer backed by `storage.local`.
- [ ] **Downloads** (S) — non-renderable content types → `downloads.download`
  with a blob URL.
- [ ] **Page metadata** (S) — title/favicon from the fetched document
  (sanitized), connection-error pages with retry.
- [ ] **Store packaging** (M) — AMO signing + Chrome Web Store zip via
  `web-ext build`; the data-consent manifest key Firefox now warns about.
- [ ] **`web+httpx` site handler research** (S) — a small companion website
  calling `registerProtocolHandler("web+httpx", …)` so links work even
  without protocol_handlers support.

Acceptance: browse the demo site with styles, forms, history, and cache
hits; installable signed artifacts.

## Phase 11 — Gateway as a product

Goal: `createOriginProxyHandler` is one line away from being a deployable
"put your website on XMPP" daemon.

- [ ] **CLI** (M) — `npx xmpp-httpx-gateway --service xmpp://… --domain
  web.example.org --secret … --origin http://localhost:8080` with a config
  file (JID allowlists, budgets, transport prefs); ships as a `bin` in a
  small separate package or `xmpp-httpx/cli`.
- [ ] **Docker image** (S) — the CLI containerized; compose example pairing
  it with Prosody.
- [ ] **Observability** (M) — structured logs, request counters/latency
  histograms (Prometheus text endpoint), `onError` wired to logs.
- [ ] **Static-site mode** (S) — serve a directory (the demo-site handler
  generalized) without an HTTP origin.
- [ ] **Rate limiting** (S) — token bucket per bare JID in front of
  `authorize`.

Acceptance: `docker run … xmpp-httpx-gateway` fronts a real site; metrics
scrapeable; README quickstart under five minutes.

## Phase 12 — Beyond the WebExtension

Goal: a real `httpx://` address bar somewhere.

- [ ] **Electron shell** (L) — `protocol.handle("httpx", …)` gives genuine
  scheme registration; reuse the extension's rendering pipeline, gain real
  chrome (tabs, downloads) for free.
- [ ] **OS-level handler research** (S) — desktop `.desktop`/registry
  handlers for `httpx:` launching the Electron shell.
- [ ] **Mobile feasibility note** (S) — React Native support of xmpp.js +
  this library (document, don't build).

## Cross-cutting quick wins (any time)

- [ ] `HttpxResponse.formData()`/content-negotiation helpers (S)
- [ ] `AbortSignal.timeout()` examples + per-request `idleTimeoutMs` override (S)
- [ ] Turkish README translation (S)
- [ ] `npm run demo` one-command: compose up + register + gateway (S)
- [ ] Export a `MockSessionPair` test helper from `xmpp-httpx/testing` for
  downstream users (M)

## Suggested order

**7 → 9 → 10**, with 8 items picked opportunistically: publishing makes the
work visible while it's fresh; hardening protects it before more surface is
added; the extension is where the project's story is told. Phase 11 whenever
a real deployment shows up; phase 12 after the extension proves the UX.
