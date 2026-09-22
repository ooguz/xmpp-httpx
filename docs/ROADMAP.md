# Roadmap: next possible phases and tasks

Status today (v0.9.0, 2026-09-22; repo pushed to `ooguz/xmpp-httpx`
2026-08-29): the library implements all seven XEP-0332 body transports with
client + server, discovery + entity caps, SOCKS5 bytestreams, Content-Encoding,
a Prosody E2E suite, browser-mode CI, and the Firefox/Chromium WebExtension
browser (`examples/webext/`). The extension now renders page CSS, submits
forms, caches with real 304 revalidation, saves downloads, shows page titles
and favicons, and has an *embedded mode* (`?embedded=1`) that lets a host app
own the chrome and drives its back button through real session-history
entries. That is the mode the Firefox Klar fork (`ooguz/klar-httpx`) runs it
in as a GeckoView built-in.
Phases 1 to 6 and 10 are done; 7 is owner-blocked on npm/AMO credentials; 8
and 9 are done, Jingle S5B included; phase 11 is done (`xmpp-httpx-gateway`:
CLI, Docker image, observability, static-site mode, rate limiting); phase 12
is done (the Electron shell, the Klar fork, the Dillo plugin, and
OS-handler/mobile notes). Effort sizing: **S** ≤ half a day, **M** ≈ 1 to 3
days, **L** ≈ a week+. Marks: `[x]` done, `[~]` partially done, `[ ]` open.

## Phase 7: Release & ecosystem

Goal: make the library consumable and visible. XEP-0332 explicitly asks for
implementations to revive its standards process; be that implementation.

- [ ] **Publish `xmpp-httpx@0.9.0` to npm** (S): fully prepared (metadata,
  `prepublishOnly` gate, pack verified, v0.9.0 tagged). Owner action:
  `npm login && npm publish`, see [RELEASING.md](../RELEASING.md).
- [x] **Git remote + CI activation** (S): pushed to `ooguz/xmpp-httpx`
  2026-08-29 (private at first), `main` plus the `v0.7.0`, `v0.8.0` and `v0.9.0` tags;
  CI runs on pushes. Made public on 2026-09-15, with GitHub Pages enabled
  from the workflow so the `api-docs` job has a target.
- [x] **API reference site** (M): typedoc (`npm run docs:api`) verified
  locally; the `api-docs` CI job deploys to GitHub Pages on pushes to main
  once the repo exists.
- [x] **XSF / standards feedback** (M): the implementation-experience report
  is drafted and ready to post to standards@xmpp.org. It is kept in the
  owner's checkout only (`docs/xep-0332-feedback.md`, gitignored) until it is
  sent.
- [x] **Interop matrix page** (S): [interop.md](interop.md).

Acceptance: package installable from npm; docs site live; feedback thread
opened.

## Phase 8: Protocol completeness & interop

Goal: close the remaining spec-adjacent gaps.

- [x] **Content-Encoding support** (M): transparent gzip/deflate on both
  sides via CompressionStream (v0.6.0); requests are not auto-compressed
  (there is no negotiation channel; callers may pre-compress).
- [x] **XEP-0348 / auth patterns** (M): concluded. JID-based auth is the
  pattern (SASL-authenticated `from`); the origin proxy forwards
  `X-Httpx-From`; XEP-0348 doesn't map onto httpx requests. Documented in
  [architecture.md](architecture.md) and the XSF feedback draft.
- [x] **SOCKS5 bytestreams** (L): XEP-0065 as a `sipub`/XEP-0095 SI
  stream-method alongside IBB, Node-only (`createSocks5Adapter` in
  `xmpp-httpx/node`): external-proxy and self-hosted-direct-streamhost
  candidates, automatic IBB fallback on the same sid when every candidate
  is unreachable. Details in [architecture.md](architecture.md) §SOCKS5
  Bytestreams.
- [x] **Jingle S5B, XEP-0260** (L): candidate negotiation end to end.
  `src/socks5/jingle-s5b.ts` (wire format, §2.1 priorities, §2.2 `dstaddr`, §2.4
  reconciliation), `src/jingle/s5b-negotiation.ts` (the per-session waiting, all
  of it bounded), and the `JingleManager` wiring: candidates offered in a
  `transport-info`, `candidate-used`/`candidate-error` both ways, proxy
  activation, and `transport-replace` to IBB when the negotiation cannot
  produce a usable candidate. Active whenever a `Socks5Adapter` is supplied;
  plain IBB otherwise, so browsers are unaffected.

  The negotiation is symmetric: both sides offer what they can host, both
  dial, and either direction can win, so a sender behind NAT still delivers by
  dialling out to a receiver-hosted candidate. `Socks5Adapter` therefore returns
  a duplex from both `connect()` and `openChosen()` (renamed from
  `openOutgoing`, which described only one role). The one thing that cannot be
  symmetric: candidates do not ride in the session-initiate, because XEP-0332
  embeds that element in `<data>` and builds it synchronously while gathering
  candidates is async. They follow in a `transport-info`, per §2.3. Details in
  [protocol-notes.md](protocol-notes.md).

  Tested at three levels: 24 unit tests on the pure layer (including that both
  peers resolve a tie to the *same* candidate), 6 choreography tests over the
  mock pair with a fake bytestream (happy path plus all three fallback routes),
  and 2 real-socket tests in `test/integration-node/` where a body crosses an
  actual negotiated TCP connection, with `openOutgoing` asserted to have been
  called, so a silent regression into IBB fails loudly.
- [x] **Stanza-size budgets** (S): `stanzaBudgets(maxStanzaBytes)` helper
  (v0.6.0); explicit `maxChunkSize` advertisements now honored to the spec
  max. Automatic XEP-0478 probing stays with the application, which owns
  the stream features.
- [x] **Roster-policy helpers** (M): `presencePolicy` + `manualPolicy`
  (v0.6.0); "provisioned" (XEP-0324) remains out of scope.
- [x] **Reconnect resilience** (M): semantics documented
  ([architecture.md](architecture.md) §Sessions), dead-link-mid-stream
  surfaces as a tested `timeout` error; bodies are never silently truncated.

Acceptance (met): compressed bodies round-trip with wire-level proof (zero chunk
stanzas for a 288 KB text body), and SOCKS5 bytestreams exist on both the sipub
(XEP-0065) and jingle (XEP-0260) paths. The phase 9 throughput benchmark
comparing them against IBB on Node has now run; see Phase 9.

## Phase 9: Hardening & performance

Goal: trust the implementation under adversarial and heavy load.

- [x] **Codec fuzzing** (M): fast-check arbitrary-XML fuzzing of
  `decodeReq`/`decodeResp`/chunk/IBB handlers: no crash, only
  `CodecError`/IQ-error outcomes (`test/unit/fuzz.test.ts`).
- [x] **Adversarial-peer suite** (M): a hostile mock peer (chunk floods for
  unknown streams, sid collisions, seq desync, oversized blocks, withheld
  acks, early terminates) asserting that every bound in the security model
  holds (`test/integration/adversarial.test.ts`; drove the IBB idle-timeout
  fix).
- [x] **Throughput benchmarks** (M): bytes/sec per transport (inline vs
  chunked vs IBB) over the mock pair; `npm run bench`, tracked in CI as an
  informational `workflow_dispatch` job. S5B included since 2026-08-30
  (`test/bench/s5b.bench.ts`): the sipub (XEP-0065) and Jingle (XEP-0260)
  bodies cross a real loopback TCP socket via a self-hosted streamhost,
  against an IBB baseline, with a per-round-trip guard proving none
  silently fell back to IBB; ~1.3 to 2×/12×/25× IBB at 64 KiB/1 MiB/8 MiB.
  Its first run caught and fixed an O(body²/blockSize) re-copy in both
  stream senders (`BlockBuffer` in `src/util/bytes.ts`). The Prosody-side
  run landed 2026-09-03: `npm run bench:prosody`
  (`test/e2e/transports.prosody.bench.ts`) wire-clocks client↔component
  through the Dockerized Prosody. S5B is nearly size-independent while the
  relayed transports scale with size (8 MiB: sipub ~40× IBB, ~19×
  chunkedBase64; details in [testing.md](testing.md) §Benchmarks).
- [x] **Memory audit** (S): `scripts/memcheck.mjs` streams 1 MiB and 16 MiB
  IBB bodies and samples live (post-GC) heap; fails if retention scales
  with body size. Verified locally: 0.00x heap ratio for a 16x larger body.
- [x] **Security review** (M): run over the phase 10 extension work (CSS
  sanitizer, forms, downloads, metadata, cache). Two real findings, both fixed
  in the same round. Page-declared favicons were honored over `https:`,
  which let any visited page make the *privileged extension origin* issue a
  cross-origin request (now httpx-only). And the response cache was shared
  across XMPP accounts even though httpx authorizes per requester JID (now
  partitioned as `httpx-v1:<bare JID>`). Everything else held: no script
  execution path into the iframe, no rule/markup injection through CSSOM
  serialization, no traversal through `Content-Disposition`, no forged
  freshness (`x-httpx-stored-at` is always overwritten locally, `Age` is
  clamped). External eyes on the sandbox reasoning are still worth having,
  and the reviewer briefing is ready:
  [security-review-dossier.md](security-review-dossier.md) (threat model,
  ranked attack requests, prior findings, accepted risks).

Acceptance: fuzz + adversarial suites green in CI (done); published
benchmark numbers (done: mock-pair transports, real-TCP S5B, and the
wire-clocked Prosody run); no O(body) memory paths (done); security review
done (two findings, both fixed). An outside reviewer on the sandbox/rendering
reasoning remains the one thing self-review cannot supply.

## Phase 10: Browser extension v2

Goal: from demo to daily-drivable.

- [x] **Sanitized CSS subset** (L): `<style>` blocks and `style=` attributes
  now pass through a CSSOM-based sanitizer (`examples/webext/src/sanitize-css.ts`):
  rule allow-list, every `url()` through a resolver, `@import`/`expression()`
  refused, `</style>` re-escaped. httpx `url()` references are *fetched* into
  `blob:` URLs like images (two-pass render), so background images and
  webfonts served over XMPP actually render. Tested in real Chromium
  (`test/browser/`); reasoning in [browser-extension.md](browser-extension.md)
  §CSS.
- [x] **Progressive rendering → byte-progress feedback** (M): the item was
  split as promised, and the honest half shipped. Streaming *rendering* stays
  rejected: the pipeline's safety comes from sanitizing a *complete* document
  (`WHOLE_DOCUMENT` DOMPurify, one CSSOM pass, one `srcdoc` assignment),
  partial markup is exactly where mXSS lives, and re-sanitizing a growing
  buffer on every chunk is O(n²) plus visible reflow. But the wait is no
  longer blind. `src/progress.ts` counts bytes where the network stream is
  actually consumed (the cache layer's miss path, or the raw POST/bypass
  read; one of the two per load, decided by the cache state), reports per
  tab under the same `loadSeq` supersession guard the renders use, and the
  chrome shows a thin bar (outside the hideable chrome, so embedded
  mode/Klar keeps it) plus a byte chip. Content-Length, when it survives
  (it is deleted on transparent decompression, so a survivor matches the
  counted bytes), makes the bar determinate. Reasoning in
  [browser-extension.md](browser-extension.md) §Caching.
- [x] **Forms** (M): GET and `application/x-www-form-urlencoded` POST forms
  (`examples/webext/src/forms.ts`). Submission is driven from control clicks
  and Enter-key implicit submission rather than a `submit` listener: the
  sandbox has no `allow-forms` and Chromium checks that flag before
  dispatching the event, so widening the sandbox was the only alternative,
  and that was declined. Uploads, multipart, and non-httpx actions are
  refused with an explanation.
- [x] **Caching** (M): Cache API keyed by httpx URL
  (`examples/webext/src/cache.ts`): `no-store`/`no-cache`/`max-age`/`Expires`/
  `Age` freshness, `If-None-Match`/`If-Modified-Since` revalidation, POST
  invalidating the entry it targeted, reload forcing revalidation, and a
  `cache`/`304`/`network` chip in the chrome. The demo site now serves ETags
  and answers `If-None-Match` with a real 304, covered end-to-end against
  Prosody.
- [x] **History + bookmarks UI** (M): split out of the tab-strip item below and
  shipped: a drawer (`src/history.ts` + `src/drawer.ts`) over `storage.local`,
  dedup-and-bump on revisit, a 500-entry cap, a bookmark star in the chrome, and
  per-entry removal. POST results and downloads are not recorded, since neither
  is a URL you can return to. Page titles are the only hostile string that
  reaches the extension's own DOM, so they are normalized on the way in and
  rendered only via `textContent` (pinned by `test/browser/drawer.test.ts`).
- [x] **Tab strip** (M): multiple pages per window, one live iframe each (so
  switching tabs never refetches), per-tab blob/favicon/cache ownership in a
  resources map, and per-tab back/forward stacks (`src/tabs.ts`). The cost,
  accepted deliberately: the hash is now a *mirror* of the active tab rather
  than the source of truth, so standalone, the platform's own Back button no
  longer walks httpx pages (one shared entry list cannot express per-tab
  history). Deep links still work. *Embedded mode* (`?embedded=1`, 2026-08-28)
  is the exception: the page's own chrome is hidden there, so page-to-page
  navigations push real session-history entries and the host's back/forward
  traversals re-enter via `hashchange`. Reasoning in
  [browser-extension.md](browser-extension.md) §Tabs.
- [x] **Downloads** (S): non-renderable content types (and any
  `Content-Disposition: attachment`) go to `downloads.download` with a blob
  URL, with an `<a download>` fallback outside an extension context;
  filenames from `filename*`/`filename`/URL, reduced to a sanitized basename.
- [x] **Page metadata** (S): title and favicon from the fetched document
  (icon fetched over httpx into a blob URL), plus scriptless error pages with
  working *Retry* / *Connection settings* actions.
- [~] **Store packaging** (M): `npm run package` in `examples/webext/` builds
  both store zips into `dist/artifacts/` via `web-ext build`, and the Firefox
  data-consent key is declared (`data_collection_permissions: {required:
  ["none"]}`), which raised `strict_min_version` to 142 because that is where
  the key landed (Firefox 140/142-Android); the extension itself needs nothing
  that new. `web-ext lint` is down to a single acknowledged warning (the
  sanitized `srcdoc` assignment). The add-on ID is final
  (`httpx-browser@ooguz.dev`, 2026-09-15), `npm run sign:firefox` wraps the
  signing call (credentials from the environment), and `npm run package`
  also writes the AMO source archive with rebuild steps. Owner-blocked: the
  AMO and Web Store accounts themselves, see [RELEASING.md](../RELEASING.md).
- [x] **`web+httpx` site handler research** (S):
  [web-httpx-handler.md](web-httpx-handler.md). Conclusion: `httpx:` itself can
  never be registered (the `registerProtocolHandler` safelist is fixed by
  spec), `web+httpx` can, but it lands on a *web page* that has no access to
  the user's account, so its only honest job is handing off to the extension
  and explaining itself when the extension is missing. Worth building together
  with store publication and not before, since it needs a published extension
  ID to hand off to on Chromium.

The demo site (`test/e2e/demo-site.ts`, served by `scripts/demo-gateway.mjs`,
kept-in-step twins) now exercises the shipped surface: a `<style>` block with
a CSS background fetched over XMPP, a favicon, GET and POST forms, an
attachment download, and the two progress-bar stages, `/download/big.bin`
(256 KB with Content-Length: the determinate bar) and `/download/slow.bin`
(trickled, length-less: the indeterminate shimmer). All of it is covered
end-to-end against Prosody in the component-gateway E2E suite and
`npm run smoke`.

Acceptance: met except signing. `npm run smoke` drives the built extension
in real Chromium against the demo gateway over real XMPP and checks exactly
that: page CSS applied, CSS `url()` and images fetched into blobs, the page's
favicon, GET and POST forms, back/forward, a 304 on revalidation, two tabs with
independent history, the drawer and bookmarks, and an attachment downloading.
Store zips build; signing needs publisher credentials.

## Phase 11: Gateway as a product

Goal: `createOriginProxyHandler` is one line away from being a deployable
"put your website on XMPP" daemon.

- [x] **CLI** (M): `xmpp-httpx-gateway`, a `bin` of the main package (no second
  package to publish): component (`--domain`/`--secret`) and client
  (`--jid`/`--password`) modes, JSON config file with
  flags > env > file > defaults precedence, `--allow`/`--allow-all` (start is
  *refused* without one, so there is no implicit public gateway),
  `--max-stanza` budgets, `--prefer` stream order, `--max-body`,
  `--jid-header`/`--no-jid-header`, `--no-compress`, `--follow-redirects`,
  per-request logging and clean SIGINT/SIGTERM shutdown. Secrets are read from
  `XMPP_HTTPX_SECRET`/`XMPP_HTTPX_PASSWORD`, and passing them in argv warns
  (visible in `ps`). Config parsing is pure and unit-tested; the whole path is
  covered against Prosody in `test/e2e/cli-gateway.e2e.test.ts`. Guide:
  [gateway-cli.md](gateway-cli.md).
- [x] **Docker image** (S): [`Dockerfile`](../Dockerfile), multi-stage, the
  runtime stage installing the `npm pack` tarball so the image runs exactly what
  `npm publish` would upload (packaging mistakes fail the build), ~170 MB on
  `node:24-alpine`, non-root, exit codes preserved, SIGTERM closing the stream
  cleanly without an init shim. No `HEALTHCHECK`, because the gateway exposes
  no port, so liveness needs the metrics item below.
  [`examples/docker/`](../examples/docker/) pairs it with Prosody and an nginx
  origin that is *not* published to the host: two commands to a browsable
  `httpx://web.localhost/`, verified end to end.
- [x] **Observability** (M): `--log-format json` (one object per line, fields as
  data), `--metrics-port` serving Prometheus text plus `/healthz`, bound to
  loopback by default since the metrics label denied JIDs. Counters for
  requests (by method and status), denials (by *bare* JID, since a resource is
  unbounded cardinality), and errors by kind; a duration histogram; and
  `httpx_gateway_stream_up`, which is the only real liveness fact a gateway with
  no request port has. `onError` and the authorization policy are both wrapped,
  so handler errors and refusals are counted as well as returned. The registry
  is hand-rolled to keep the dependency count at one. This also unblocked the
  container healthcheck that the Docker item had to skip.
- [x] **Static-site mode** (S): `--static <dir>` instead of `--origin`: index
  files, extension-based types, streamed bodies, `HEAD`, 405 for anything that
  would change something, and `ETag`/`Last-Modified`/`max-age` so revalidation
  costs a 304 with no body. Containment is checked twice, lexically after
  percent-decoding and then against the *real* path, since `resolve()` does not
  follow symlinks and a link out of the root would otherwise be served.
- [x] **Rate limiting** (S): `withRateLimit(handler, {ratePerSecond, burst})`
  in the library (browser-safe, injectable clock), wired to the CLI's `--rate`
  and `--burst`. Deliberately a handler wrapper rather than an `authorize`
  hook, as originally filed: `AuthorizeFn` can only say yes or no and the
  server renders a no as `forbidden`, whereas a throttled client deserves a real
  429 with `Retry-After`. It is no more expensive, since the server hands the
  handler an unread body stream. Keyed on the *bare* JID (resources are free
  to mint), with a bounded tracking map that evicts the least recently seen
  bucket rather than growing without limit.

Phase 11 is complete. Acceptance met: `docker compose up` in `examples/docker/`
fronts a real site over XMPP (verified: nginx pages *and* nginx's own 404
travelling back to a client), the gateway container reports `(healthy)` from
its own `/healthz`, and metrics are scrapeable. README quickstart is four
commands.

## Phase 12: Beyond the WebExtension (done)

Goal: a real `httpx://` address bar somewhere. Met: `examples/electron/` puts
`httpx://` in a genuine address bar, and the remaining reach (OS registration,
mobile) is researched and written down.

- [x] **Electron shell** (L): `examples/electron/`, where
  `protocol.handle("httpx", …)` makes the scheme Chromium's own, so the address
  bar, history, forms, downloads and subresource fetching (the main payoff) all
  come for free; the extension's blob-URL rewriting is not needed. Tabs are
  sandboxed `WebContentsView`s with no preload; the chrome is a separate view
  with a narrow `contextBridge`; scripts are off via a CSP the handler imposes
  over the server's. Run under Xvfb against the demo gateway: page, CSS, image
  and a second-instance tab all verified. The finding that shaped the design:
  a `Request` URL cannot carry credentials (Fetch standard, not
  scheme-specific), so `httpx://alice@example.org/` can never reach a
  `protocol.handle` handler. Account JIDs ride encoded in the host; component
  domains need nothing. Reasoning in [electron-shell.md](electron-shell.md).
- [x] **OS-level handler research** (S):
  [os-scheme-handlers.md](os-scheme-handlers.md): the `.desktop` MimeType, the
  Windows `URL Protocol` key and the macOS `CFBundleURLTypes` plist, plus why
  none is wired up yet (all three want a *packaged* app). The shell side is
  already done and verified (argv on first launch, `second-instance` for a
  repeat launch, `open-url` for macOS), and the note covers the security
  question a registration raises: any web page can then hand the app a URL.
- [x] **Android browser: Firefox Klar fork** (L): `ooguz/klar-httpx`
  (branch `httpx`): the archived mozilla-mobile/firefox-android monorepo's
  Klar app navigating `httpx://` URLs, by bundling `examples/webext` as a
  GeckoView built-in extension and loading its page in embedded mode behind
  Klar's own toolbar, including the system back gesture walking httpx pages
  (extension ≥0.2.2). Verified end to end on an API 34 emulator against the
  demo gateway. Build/architecture notes in the fork's `README-HTTPX.md`;
  Mozilla trademarks mean rebranding before any distribution.
- [x] **Mobile feasibility note** (S):
  [mobile-feasibility.md](mobile-feasibility.md): the library itself needs only
  polyfills (`ReadableStream`, `crypto.subtle`, no `CompressionStream`), `wss://`
  works while raw TCP and therefore SOCKS5 do not, and the actual blocker is
  rendering. A real mobile browser means `WKURLSchemeHandler` on iOS and
  `shouldInterceptRequest` on Android, i.e. native work per platform. Nothing in
  the library needs to change.
- [x] **Dillo plugin** (S, 2026-09-12): `examples/dillo/`, `httpx://` as a
  Dillo *server dpi*. Dillo routes every scheme it lacks to a plugin named
  `proto.<scheme>`, dpid starts ours once with the listening socket on fd 0,
  and one XMPP session serves every page and image after that. Dillo renders
  the page itself and has no JavaScript, so the extension's whole
  sanitizing layer has no counterpart: the plugin is dpip tags in, an HTTP
  response out (`src/dpip.ts`, `src/serve.ts`, fetch injected). Framing
  tested over the mock pair (`test/integration-node/dillo-dpi.test.ts`);
  `npm run smoke:dillo` runs a real dpid and real Dillo under Xvfb against
  the demo gateway and keeps the screenshot. `dpi:/httpx/` (2026-09-15) is
  the plugin's own status page with a settings form that writes
  `httpx.json`. Packaged (2026-09-15): `npm run package` builds a tarball
  with the esbuild bundle, a node-finding launcher, an installer and the
  bundled dependencies' licenses; the smoke test installs from it. Limits are
  Dillo's: no POST (plugins receive only the URL), no revalidation.
  Reasoning in [dillo-plugin.md](dillo-plugin.md).

## Phase 13: n146 groundwork

Goal: the library work the [n146](https://github.com/ooguz/n146) web-over-XMPP
proxy needs from this side, in the order its design document asks for it
(`docs/design.md` §5.2). Nothing here is proxy-specific — every item is a
throughput or correctness gap that happens to bite hardest when a browser is
on the other end.

- [x] **Windowed IBB sending** (M, 2026-09-21): `window` blocks in flight, the
  IQ result of block k releasing block k+window; `ibbWindow` and
  `ibbBlockSize` on both `HttpxClient` and `HttpxServer`, block size still
  derived from the peer's `maxChunkSize` (i.e. from `stanzaBudgets()`, i.e.
  from XEP-0478 where a server advertises it). Ordering holds because taking,
  encoding and sending a block is one synchronous step; a block's IQ error
  closes the stream with the *earliest* failure in send order; a receiver that
  stops reading still stops the sender dead, and one that is deliberately
  withholding acks now stretches its own idle deadline across the window
  instead of timing out a healthy stream. The receiver's queue grew the other
  half of the window — without it the first 64 KiB block drives `desiredSize`
  to 0 and the window collapses back to one block per round trip. On a
  simulated 100 ms path a 1 MiB body goes from 40.2 KB/s to 2.41 MB/s (window
  8, 64 KiB blocks), and over a real Prosody 8 MiB of IBB now moves at
  9.17 MB/s — past `chunkedBase64` for the first time. Numbers in
  [architecture.md](architecture.md#throughput).
- [x] **`CONNECT` and the request-target forms** (S, 2026-09-21): `CONNECT` in
  `HTTP_METHODS` (a deliberate departure from XEP-0332 v0.5.1, recorded in
  [protocol-notes.md](protocol-notes.md)), and `resource` validation for
  authority-form (`example.org:443`, `CONNECT` only, per RFC 9112 §3.2.3) and
  absolute-form (`https://example.org/x`). Origin-form decodes exactly as
  before.
- [x] **Bidirectional stream body** (M, 2026-09-22): `IbbManager.openDuplex()`
  / `expectDuplex()` — one IBB session, the opener's sid in both directions,
  a `seq` counter per direction, the acceptor adopting the sid without an
  `<open>`. No half-close (either `<close/>` ends both ways, crossing closes
  both succeed via a tombstone); writes flush their sub-block tail at once,
  since a tunnel is interactive. On top of it `HttpxClient.connect()` and a
  handler's `{ status: 200, tunnel }`; the library dials nothing. IBB only —
  an S5B duplex waits for the `fast` profile. Tunnels are opt-in on the
  server (`tunnels: true`) and advertised as `urn:xmpp:http:connect:0`, which
  `connect()` checks. One wire form (`<req method='CONNECT'>`) until the XSF
  answers — decided 2026-09-22; the `<connect>` companion of design §4.2 is
  additive when needed (a decoder and a disco-driven choice).
- [ ] **Fair scheduling** (M): many concurrent streams share one XMPP
  connection; the sender should round-robin blocks across active streams so
  one large download cannot starve twenty small ones. A per-session scheduler
  in front of the IBB sender — the window makes this both possible and
  necessary, since a single stream can now hold several slots.
- [x] **Tunnel-aware watchdogs** (S, 2026-09-22): the idle timeout is per
  stream; a duplex defaults to `false` (no idle timer, no stretched
  ack-withholding deadline), bodies keep theirs. The sender's per-block ack
  deadline stays on for tunnels — it is not an idle timer. Client/server
  `idleTimeoutMs` now reach an IBB body's own watchdog too.
- [x] **Absolute-form discovery** (S, 2026-09-22): `urn:xmpp:http#absolute-form`
  advertised; `DiscoCache.supports(jid, feature)`.
- [ ] **XEP-0198 resumption** (M): stream management with resumption keeps
  long-lived streams alive across a brief network loss. Also bounds the
  retained outbound queue, which a saturated windowed sender grows (see
  [architecture.md](architecture.md#throughput)).
- [ ] **XEP-0478 stream limits** (S): nothing in the `@xmpp` stack parses the
  `<limits/>` stream feature, so `stanzaBudgets()` is fed by hand today. It
  arrives before resource binding, so reading it means a nonza listener
  installed before `entity.start()` resolves.

## Cross-cutting quick wins (any time)

- [ ] **CI action versions** (S): every job in `.github/workflows/ci.yml` pins
  `actions/checkout@v4` and `actions/setup-node@v4`, which target Node 20;
  GitHub already forces them onto Node 24 and warns on every run. Bump both to
  `@v5` (and `upload-pages-artifact`/`deploy-pages` while there). Separately,
  `ubuntu-latest` becomes Ubuntu 26 on 2026-10-19 — worth one run on
  `ubuntu-26.04` before the label moves, since the e2e job brings up Docker.
- [x] `HttpxResponse.formData()`, which delegates to the platform's parser, so
  multipart works without a multipart parser living here, plus
  `parseAccept`/`negotiateContentType` for content negotiation that gets
  q-values, wildcards and "most specific pattern wins" right (S)
- [x] Per-request `idleTimeoutMs` override (client and `httpxFetch`), and
  `AbortSignal.timeout()` covered by both docs and tests (S)
- [x] Turkish README: [README.tr.md](../README.tr.md), linked both ways (S)
- [x] `npm run demo`: Prosody up, users registered, library built if needed,
  demo site served, next steps printed; `npm run demo -- --down` to stop (S)
- [x] `xmpp-httpx/testing`: the integration harness (`createSessionPair`,
  `MockSession`, `deliverHook` fault injection) moved to `src/testing/` and
  published as a subpath, so downstream code can be tested without an XMPP
  server. It is the same harness this library's own suite runs on, which is
  what keeps it honest (M)

## Suggested order

Phases 7, 9 and 10 in that order, with 8 items picked opportunistically:
publishing makes the work visible while it's fresh; hardening protects it
before more surface is added; the extension is where the project's story is
told. Phase 11 whenever a real deployment shows up; phase 12 after the
extension proves the UX.
