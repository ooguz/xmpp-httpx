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

- [ ] **Publish `xmpp-httpx@0.5.0` to npm** (S) — fully prepared (metadata,
  `prepublishOnly` gate, pack verified, v0.5.0 tagged); owner action:
  `npm login && npm publish` — see [RELEASING.md](../RELEASING.md).
- [ ] **Git remote + CI activation** (S) — prepared (badges, Pages CI job,
  repo URLs assume `ooguz/xmpp-httpx`); owner action: `gh repo create` +
  push — see [RELEASING.md](../RELEASING.md).
- [x] **API reference site** (M) — typedoc (`npm run docs:api`) verified
  locally; the `api-docs` CI job deploys to GitHub Pages on pushes to main
  once the repo exists.
- [x] **XSF / standards feedback** (M) — [xep-0332-feedback.md](xep-0332-feedback.md)
  drafted and ready to post to standards@xmpp.org.
- [x] **Interop matrix page** (S) — [interop.md](interop.md).

Acceptance: package installable from npm; docs site live; feedback thread
opened.

## Phase 8 — Protocol completeness & interop

Goal: close the remaining spec-adjacent gaps.

- [x] **Content-Encoding support** (M) — transparent gzip/deflate on both
  sides via CompressionStream (v0.6.0); requests are not auto-compressed
  (no negotiation channel — callers may pre-compress).
- [x] **XEP-0348 / auth patterns** (M) — concluded: JID-based auth is the
  pattern (SASL-authenticated `from`); origin proxy forwards `X-Httpx-From`;
  XEP-0348 doesn't map onto httpx requests — documented in
  [architecture.md](architecture.md) and the XSF feedback draft.
- [x] **SOCKS5 bytestreams** (L) — XEP-0065 as a `sipub`/XEP-0095 SI
  stream-method alongside IBB, Node-only (`createSocks5Adapter` in
  `xmpp-httpx/node`): external-proxy and self-hosted-direct-streamhost
  candidates, automatic IBB fallback on the same sid when every candidate
  is unreachable. Details in [architecture.md](architecture.md) §SOCKS5
  Bytestreams.
- [ ] **Jingle S5B — XEP-0260** (L) — deliberately deferred out of the SOCKS5
  bytestreams work above: needs real transport candidate negotiation
  (`transport-info`/`candidate-used`/`candidate-error`/`transport-replace`)
  that the current minimal `JingleManager` doesn't support at all (it skips
  candidate exchange entirely and jumps straight to a single embedded
  session-initiate over IBB). A separate, substantially larger round.
- [x] **Stanza-size budgets** (S) — `stanzaBudgets(maxStanzaBytes)` helper
  (v0.6.0); explicit `maxChunkSize` advertisements now honored to the spec
  max. Automatic XEP-0478 probing stays with the application, which owns
  the stream features.
- [x] **Roster-policy helpers** (M) — `presencePolicy` + `manualPolicy`
  (v0.6.0); "provisioned" (XEP-0324) remains out of scope.
- [x] **Reconnect resilience** (M) — semantics documented
  ([architecture.md](architecture.md) §Sessions), dead-link-mid-stream
  surfaces as a tested `timeout` error; bodies are never silently truncated.

Acceptance (met for the shipped items): compressed bodies round-trip with
wire-level proof (zero chunk stanzas for a 288 KB text body); the sipub/S5B
transport now exists, so the phase 9 throughput benchmark comparing it
against IBB on Node is unblocked but still not run.

## Phase 9 — Hardening & performance

Goal: trust the implementation under adversarial and heavy load.

- [x] **Codec fuzzing** (M) — fast-check arbitrary-XML fuzzing of
  `decodeReq`/`decodeResp`/chunk/IBB handlers: no crash, only
  `CodecError`/IQ-error outcomes (`test/unit/fuzz.test.ts`).
- [x] **Adversarial-peer suite** (M) — a hostile mock peer: chunk floods for
  unknown streams, sid collisions, seq desync, oversized blocks, withheld
  acks, early terminates — assert every bound in the security model holds
  (`test/integration/adversarial.test.ts`; drove the IBB idle-timeout fix).
- [x] **Throughput benchmarks** (M) — bytes/sec per transport (inline vs
  chunked vs IBB) over the mock pair; `npm run bench`, tracked in CI as an
  informational `workflow_dispatch` job. S5B now exists (sipub/XEP-0065, see
  Phase 8) but isn't in `npm run bench` yet — it needs real TCP sockets, not
  the mock pair; no Prosody-side benchmark yet either (mock-pair numbers are
  comparative, not wire-clocked).
- [x] **Memory audit** (S) — `scripts/memcheck.mjs` streams 1 MiB and 16 MiB
  IBB bodies and samples live (post-GC) heap; fails if retention scales
  with body size. Verified locally: 0.00x heap ratio for a 16x larger body.
- [ ] **Security review** (M) — run `/security-review` over the full tree;
  external eyes on the sandbox/rendering pipeline reasoning in the
  extension.

Acceptance: fuzz + adversarial suites green in CI (done); published
benchmark numbers (done, mock-pair only); no O(body) memory paths (done);
security review still open.

## Phase 10 — Browser extension v2

Goal: from demo to daily-drivable.

- [x] **Sanitized CSS subset** (L) — `<style>` blocks and `style=` attributes
  now pass through a CSSOM-based sanitizer (`examples/webext/src/sanitize-css.ts`):
  rule allow-list, every `url()` through a resolver, `@import`/`expression()`
  refused, `</style>` re-escaped. httpx `url()` references are *fetched* into
  `blob:` URLs like images (two-pass render), so background images and
  webfonts served over XMPP actually render. Tested in real Chromium
  (`test/browser/`); reasoning in [browser-extension.md](browser-extension.md)
  §CSS.
- [ ] **Progressive rendering** (M) — render HTML as it streams (the body is
  already a stream; today the extension buffers `text()` first).
- [x] **Forms** (M) — GET and `application/x-www-form-urlencoded` POST forms
  (`examples/webext/src/forms.ts`). Submission is driven from control clicks
  and Enter-key implicit submission, *not* a `submit` listener: the sandbox has
  no `allow-forms` and Chromium checks that flag before dispatching the event,
  so widening the sandbox was the only alternative — declined. Uploads,
  multipart, and non-httpx actions are refused with an explanation.
- [x] **Caching** (M) — Cache API keyed by httpx URL
  (`examples/webext/src/cache.ts`): `no-store`/`no-cache`/`max-age`/`Expires`/
  `Age` freshness, `If-None-Match`/`If-Modified-Since` revalidation, POST
  invalidating the entry it targeted, reload forcing revalidation, and a
  `cache`/`304`/`network` chip in the chrome. The demo site now serves ETags
  and answers `If-None-Match` with a real 304, covered end-to-end against
  Prosody.
- [ ] **Tab strip + history UI** (M) — multiple pages per window, a
  history/bookmarks drawer backed by `storage.local`.
- [x] **Downloads** (S) — non-renderable content types (and any
  `Content-Disposition: attachment`) → `downloads.download` with a blob URL,
  `<a download>` fallback outside an extension context; filenames from
  `filename*`/`filename`/URL, reduced to a sanitized basename.
- [x] **Page metadata** (S) — title and favicon from the fetched document
  (icon fetched over httpx into a blob URL), plus scriptless error pages with
  working *Retry* / *Connection settings* actions.
- [ ] **Store packaging** (M) — AMO signing + Chrome Web Store zip via
  `web-ext build`; the data-consent manifest key Firefox now warns about.
- [ ] **`web+httpx` site handler research** (S) — a small companion website
  calling `registerProtocolHandler("web+httpx", …)` so links work even
  without protocol_handlers support.

The demo site (`test/e2e/demo-site.ts`, served by `scripts/demo-gateway.mjs`)
now exercises the shipped surface: a `<style>` block with a CSS background
fetched over XMPP, a favicon, GET and POST forms, and an attachment download —
covered end-to-end against Prosody in the component-gateway E2E suite.

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
