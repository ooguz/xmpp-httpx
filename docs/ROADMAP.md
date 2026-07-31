# Roadmap — next possible phases and tasks

Status today (v0.6.0 + phase 10 work, 2026-07-30): the library implements
**all seven XEP-0332 body transports** with client + server, discovery +
entity caps, SOCKS5 bytestreams, Content-Encoding, a Prosody E2E suite,
browser-mode CI, and the Firefox/Chromium WebExtension browser
(`examples/webext/`) — which now renders page CSS, submits forms, caches with
real 304 revalidation, saves downloads, and shows page titles and favicons.
Phases 1–6 and 10 are done; 7 is owner-blocked on npm/AMO credentials; 8 and 9
are done bar Jingle S5B (whose protocol layer landed separately); phase 11 is done (`xmpp-httpx-gateway`: CLI, Docker
image, observability, static-site mode, rate limiting); phase 12 is done (the
Electron shell, with OS-handler and mobile notes). Effort sizing: **S** ≤ half a day, **M** ≈ 1–3 days,
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
- [~] **Jingle S5B — XEP-0260** (L) — **protocol layer done, session wiring not.**

  Done and tested (`src/socks5/jingle-s5b.ts`, 24 unit tests): the
  `<transport>`/`<candidate>` codec, `<candidate-used>`/`<candidate-error>`/
  `<activated>`/`<proxy-error>` payloads, the §2.1 priority arithmetic, the §2.2
  `dstaddr`, candidate ordering, and `resolve()` — the §2.4 reconciliation of the
  two sides' reports, including the tie-break reading that keeps both peers
  choosing the *same* candidate instead of deadlocking (asserted from both
  viewpoints; interpretation recorded in
  [protocol-notes.md](protocol-notes.md)). Exported, so it is usable on its own.

  Remaining, and deliberately not rushed — this transport carries response
  bodies, so a half-built state machine is worse than none:

  1. `JingleManager.offer()` building an s5b transport (candidates from a
     `Socks5Adapter`) instead of the IBB one, when an adapter is present.
  2. `session-accept` carrying the responder's candidates, and a real
     `transport-info` handler — today `transport-info` is acked and ignored, and
     non-IBB transports are declined outright.
  3. The connect race on both sides (the adapter's `connect()` already does the
     client half; `candidatesFor()` already hosts a direct streamhost), then
     exchanging reports and applying `resolve()`.
  4. Proxy activation for a winning `type='proxy'` candidate: an XEP-0065
     `<activate/>` IQ to the proxy, then `<activated cid=…/>`.
  5. `transport-replace` → IBB when `resolve()` returns `fallback`, plus the
     accept/reject of a replacement.
  6. Tests: the full choreography over the mock pair with a fake adapter, and a
     real-socket case in `test/integration-node/` alongside the existing
     XEP-0065 one.
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

- [x] **CLI** (M) — `xmpp-httpx-gateway`, a `bin` of the main package (no second
  package to publish): component (`--domain`/`--secret`) and client
  (`--jid`/`--password`) modes, JSON config file with
  flags > env > file > defaults precedence, `--allow`/`--allow-all` (start is
  *refused* without one — no implicit public gateway), `--max-stanza` budgets,
  `--prefer` stream order, `--max-body`, `--jid-header`/`--no-jid-header`,
  `--no-compress`, `--follow-redirects`, per-request logging and clean
  SIGINT/SIGTERM shutdown. Secrets are read from `XMPP_HTTPX_SECRET`/
  `XMPP_HTTPX_PASSWORD`, and passing them in argv warns (visible in `ps`).
  Config parsing is pure and unit-tested; the whole path is covered against
  Prosody in `test/e2e/cli-gateway.e2e.test.ts`. Guide:
  [gateway-cli.md](gateway-cli.md).
- [x] **Docker image** (S) — [`Dockerfile`](../Dockerfile): multi-stage, the
  runtime stage installing the `npm pack` tarball so the image runs exactly what
  `npm publish` would upload (packaging mistakes fail the build), ~170 MB on
  `node:24-alpine`, non-root, exit codes preserved, SIGTERM closing the stream
  cleanly without an init shim. No `HEALTHCHECK` — the gateway exposes no port,
  so liveness needs the metrics item below.
  [`examples/docker/`](../examples/docker/) pairs it with Prosody and an nginx
  origin that is *not* published to the host: two commands to a browsable
  `httpx://web.localhost/`, verified end to end.
- [x] **Observability** (M) — `--log-format json` (one object per line, fields as
  data), `--metrics-port` serving Prometheus text plus `/healthz`, bound to
  loopback by default since the metrics label denied JIDs. Counters for
  requests (by method and status), denials (by *bare* JID — a resource is
  unbounded cardinality), and errors by kind; a duration histogram; and
  `httpx_gateway_stream_up`, which is the only real liveness fact a gateway with
  no request port has. `onError` and the authorization policy are both wrapped,
  so handler errors and refusals are counted, not just returned. The registry is
  hand-rolled to keep the dependency count at one. This also unblocked the
  container healthcheck that the Docker item had to skip.
- [x] **Static-site mode** (S) — `--static <dir>` instead of `--origin`: index
  files, extension-based types, streamed bodies, `HEAD`, 405 for anything that
  would change something, and `ETag`/`Last-Modified`/`max-age` so revalidation
  costs a 304 with no body. Containment is checked twice — lexically after
  percent-decoding, then against the *real* path, since `resolve()` does not
  follow symlinks and a link out of the root would otherwise be served.
- [x] **Rate limiting** (S) — `withRateLimit(handler, {ratePerSecond, burst})`
  in the library (browser-safe, injectable clock), wired to the CLI's `--rate`
  and `--burst`. Deliberately a **handler wrapper rather than an `authorize`
  hook**, as originally filed: `AuthorizeFn` can only say yes or no and the
  server renders a no as `forbidden`, whereas a throttled client deserves a real
  429 with `Retry-After` — and it is no more expensive, since the server hands
  the handler an unread body stream. Keyed on the *bare* JID (resources are free
  to mint), with a bounded tracking map that evicts the least recently seen
  bucket rather than growing without limit.

**Phase 11 complete.** Acceptance: met — `docker compose up` in `examples/docker/` fronts a real site
over XMPP (verified: nginx pages *and* nginx's own 404 travelling back to a
client), the gateway container reports `(healthy)` from its own `/healthz`, and
metrics are scrapeable. README quickstart is four commands.

## Phase 12 — Beyond the WebExtension — **done**

Goal: a real `httpx://` address bar somewhere. Met: `examples/electron/` puts
`httpx://` in a genuine address bar, and the remaining reach (OS registration,
mobile) is researched and written down rather than guessed at.

- [x] **Electron shell** (L) — `examples/electron/`: `protocol.handle("httpx", …)`
  makes the scheme Chromium's own, so the address bar, history, forms, downloads
  and — the real prize — **subresource fetching** all come for free; the
  extension's blob-URL rewriting simply is not needed. Tabs are sandboxed
  `WebContentsView`s with no preload; the chrome is a separate view with a
  narrow `contextBridge`; scripts are off via a CSP the handler imposes over the
  server's. Run under Xvfb against the demo gateway: page, CSS, image and a
  second-instance tab all verified.
  **The finding that shaped it:** a `Request` URL cannot carry credentials (Fetch
  standard, not scheme-specific), so `httpx://alice@example.org/` can never reach
  a `protocol.handle` handler — account JIDs ride encoded in the host, component
  domains need nothing. Reasoning in [electron-shell.md](electron-shell.md).
- [x] **OS-level handler research** (S) —
  [os-scheme-handlers.md](os-scheme-handlers.md): the `.desktop` MimeType, the
  Windows `URL Protocol` key and the macOS `CFBundleURLTypes` plist, plus why
  none is wired up yet (all three want a *packaged* app). The shell side is
  already done and verified — argv on first launch, `second-instance` for a
  repeat launch, `open-url` for macOS — and the note covers the security
  question a registration raises: any web page can then hand the app a URL.
- [x] **Mobile feasibility note** (S) —
  [mobile-feasibility.md](mobile-feasibility.md): the library itself needs only
  polyfills (`ReadableStream`, `crypto.subtle`, no `CompressionStream`), `wss://`
  works while raw TCP and therefore SOCKS5 do not, and the actual blocker is
  rendering — a real mobile browser means `WKURLSchemeHandler` on iOS and
  `shouldInterceptRequest` on Android, i.e. native work per platform. Nothing in
  the library needs to change, which is the useful conclusion.

## Cross-cutting quick wins (any time)

- [x] `HttpxResponse.formData()` — delegates to the platform's parser, so
  multipart works without a multipart parser living here — plus
  `parseAccept`/`negotiateContentType` for content negotiation that gets
  q-values, wildcards and "most specific pattern wins" right (S)
- [x] Per-request `idleTimeoutMs` override (client and `httpxFetch`), and
  `AbortSignal.timeout()` covered by both docs and tests (S)
- [x] Turkish README — [README.tr.md](../README.tr.md), linked both ways (S)
- [x] `npm run demo` — Prosody up, users registered, library built if needed,
  demo site served, next steps printed; `npm run demo -- --down` to stop (S)
- [x] `xmpp-httpx/testing` — the integration harness (`createSessionPair`,
  `MockSession`, `deliverHook` fault injection) moved to `src/testing/` and
  published as a subpath, so downstream code can be tested without an XMPP
  server. It is the same harness this library's own suite runs on, which is what
  keeps it honest (M)

## Suggested order

**7 → 9 → 10**, with 8 items picked opportunistically: publishing makes the
work visible while it's fresh; hardening protects it before more surface is
added; the extension is where the project's story is told. Phase 11 whenever
a real deployment shows up; phase 12 after the extension proves the UX.
