# Roadmap — next possible phases and tasks

Status today (v0.6.0 + phase 10 work, 2026-07-30): the library implements
**all seven XEP-0332 body transports** with client + server, discovery +
entity caps, SOCKS5 bytestreams, Content-Encoding, a Prosody E2E suite,
browser-mode CI, and the Firefox/Chromium WebExtension browser
(`examples/webext/`) — which now renders page CSS, submits forms, caches with
real 304 revalidation, saves downloads, and shows page titles and favicons.
Phases 1–6 are done; 7 is owner-blocked on npm/AMO credentials; 8 and 9 are
done bar Jingle S5B. Effort sizing: **S** ≤ half a day, **M** ≈ 1–3 days,
**L** ≈ a week+. Marks: `[x]` done, `[~]` partially done, `[ ]` open.

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
- [x] **Security review** (M) — run over the phase 10 extension work (CSS
  sanitizer, forms, downloads, metadata, cache). Two real findings, both fixed
  in the same round: page-declared **favicons were honored over `https:`**,
  which let any visited page make the *privileged extension origin* issue a
  cross-origin request (now httpx-only); and the **response cache was shared
  across XMPP accounts** even though httpx authorizes per requester JID (now
  partitioned as `httpx-v1:<bare JID>`). Everything else held: no script
  execution path into the iframe, no rule/markup injection through CSSOM
  serialization, no traversal through `Content-Disposition`, no forged
  freshness (`x-httpx-stored-at` is always overwritten locally, `Age` is
  clamped). External eyes on the sandbox reasoning are still worth having.

Acceptance: fuzz + adversarial suites green in CI (done); published
benchmark numbers (done, mock-pair only); no O(body) memory paths (done);
security review done (two findings, both fixed) — an outside reviewer on the
sandbox/rendering reasoning remains the one thing self-review cannot supply.

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
- [ ] **Progressive rendering** (M) — **deliberately deferred**, and it needs
  a different design than "render HTML as it streams". The pipeline's safety
  comes from sanitizing a *complete* document (`WHOLE_DOCUMENT` DOMPurify, then
  one CSSOM pass, then one `srcdoc` assignment); partial markup is exactly
  where mXSS lives, and re-sanitizing a growing buffer on every chunk is
  O(n²) plus visible reflow. What is achievable without weakening that: stream
  the body with byte-progress feedback in the chrome, then render once. That is
  a UX task, not the streaming-HTML task the item's title implies — worth
  splitting before either is picked up. Note the cache layer buffers bodies
  too (`blob()`), so progress reporting has to be plumbed through it.
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
- [x] **History + bookmarks UI** (M) — split out of the tab-strip item below and
  shipped: a drawer (`src/history.ts` + `src/drawer.ts`) over `storage.local`,
  dedup-and-bump on revisit, a 500-entry cap, a bookmark star in the chrome, and
  per-entry removal. POST results and downloads are not recorded — neither is a
  URL you can return to. Page titles are the only hostile string that reaches
  the extension's own DOM, so they are normalized on the way in and rendered
  only via `textContent` (pinned by `test/browser/drawer.test.ts`).
- [x] **Tab strip** (M) — multiple pages per window, one live iframe each (so
  switching tabs never refetches), per-tab blob/favicon/cache ownership in a
  resources map, and **per-tab back/forward stacks** (`src/tabs.ts`). The cost,
  accepted deliberately: the hash is now a *mirror* of the active tab rather
  than the source of truth, so the platform's own Back button no longer walks
  httpx pages — one shared entry list cannot express per-tab history. Deep links
  still work. Reasoning in [browser-extension.md](browser-extension.md) §Tabs.
- [x] **Downloads** (S) — non-renderable content types (and any
  `Content-Disposition: attachment`) → `downloads.download` with a blob URL,
  `<a download>` fallback outside an extension context; filenames from
  `filename*`/`filename`/URL, reduced to a sanitized basename.
- [x] **Page metadata** (S) — title and favicon from the fetched document
  (icon fetched over httpx into a blob URL), plus scriptless error pages with
  working *Retry* / *Connection settings* actions.
- [~] **Store packaging** (M) — `npm run package` in `examples/webext/` builds
  both store zips into `dist/artifacts/` via `web-ext build`, and the Firefox
  data-consent key is declared (`data_collection_permissions: {required:
  ["none"]}`), which raised `strict_min_version` to 142 — the key landed in
  Firefox 140/142-Android, not because the extension needs anything that new.
  `web-ext lint` is down to a single acknowledged warning (the sanitized
  `srcdoc` assignment). **Owner-blocked**: AMO signing and Web Store upload
  need publisher credentials — see [RELEASING.md](../RELEASING.md).
- [x] **`web+httpx` site handler research** (S) —
  [web-httpx-handler.md](web-httpx-handler.md). Conclusion: `httpx:` itself can
  never be registered (the `registerProtocolHandler` safelist is fixed by
  spec), `web+httpx` can, but it lands on a *web page* that has no access to
  the user's account — so its only honest job is handing off to the extension
  and explaining itself when the extension is missing. Worth building with
  store publication, not before; it needs a published extension ID to hand off
  to on Chromium.

The demo site (`test/e2e/demo-site.ts`, served by `scripts/demo-gateway.mjs`)
now exercises the shipped surface: a `<style>` block with a CSS background
fetched over XMPP, a favicon, GET and POST forms, and an attachment download —
covered end-to-end against Prosody in the component-gateway E2E suite.

Acceptance: **met except signing** — `npm run smoke` drives the built extension
in real Chromium against the demo gateway over real XMPP and checks exactly
that: page CSS applied, CSS `url()` and images fetched into blobs, the page's
favicon, GET and POST forms, back/forward, a 304 on revalidation, two tabs with
independent history, the drawer and bookmarks, and an attachment downloading.
Store zips build; signing needs publisher credentials.

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
