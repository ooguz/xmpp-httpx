# xmpp-httpx — Testing infrastructure

Three vitest projects (configured in `vitest.config.ts` via `test.projects`),
plus a manual demo path. Everything below `session.send()` is exercised by
in-memory sessions; everything including the wire is exercised by the E2E
suite against a real Prosody.

## Projects at a glance

| Project | Command | Environment | What runs |
|---|---|---|---|
| `node` | `npm test` | Node | `test/unit/**` + `test/integration/**` |
| `browser` | `npm run test:browser` | headless Chromium (Playwright) | the exact same suites |
| `e2e` | `npm run test:e2e` | Node + Docker | `test/e2e/**/*.e2e.test.ts` against live Prosody |

The `browser` project exists to *prove* the browser-safe-core rule: the full
protocol stack — codec, chunk reassembly, IBB flow control, sipub/jingle
handshakes, client↔server integration — runs in a real browser engine.
Everything the suites need is environment-agnostic; XML fixtures are loaded
via Vite `?raw` static imports so one test file serves both projects.
`@vitest/browser-playwright` peer-pins vitest **exactly** — upgrade the two
together.

## Unit tests (`test/unit/`)

- `codec.test.ts` — decodes fixtures transcribed **verbatim from XEP-0332's
  examples** (`test/fixtures/*.xml`), round-trips through serialize→parse,
  and covers every `CodecError` path including the sipub/jingle descriptor
  rules (wrong namespace → `unsupported`, missing id/sid → error).
- `base64.test.ts` — property-tested (fast-check) against the platform's
  `btoa` as reference; whitespace tolerance; invalid input.
- `chunked.test.ts` — the reassembler under **random chunk permutations**
  (fast-check), plus duplicate-nr, post-`last` chunks, invalid base64,
  buffer overflow, and idle-timeout error paths.
- `select.test.ts` — the encoding decision table, including preference
  order and per-mechanism accept flags.
- `caps.test.ts` — reproduces the XEP-0115 §5.2 worked example hash
  (`QgayPKawpkPSDYmwT/WM94uAlu0=`); order-independence; disco-result
  recomputation.
- `urls.test.ts`, `errors.test.ts` — URL codec incl. browser-style relative
  resolution; stanza-condition mapping.

## Integration harness (`test/integration/mock-session.ts`)

`createSessionPair()` returns two in-memory `XmppSession`s that mirror
@xmpp/iq semantics faithfully: async handlers, error elements → IQ errors,
thrown handlers → `internal-server-error`, no matching handler →
`service-unavailable`, `StanzaError`-shaped rejections with `.condition`,
timeout rejections with `name: "TimeoutError"`.

Two properties make it trustworthy:

- **Wire realism**: every stanza is serialized and re-parsed on send, so
  nothing survives that wouldn't survive real XML.
- **Fault injection**: `session.deliverHook = (stanza, deliver) => …` lets a
  test hold, drop, or reorder deliveries — the chunked suite delivers an
  entire chunk stream in **reverse order** this way.

Suites: `roundtrip.test.ts` (inline flows, failure mapping, component-style
addressing), `streaming.test.ts` (1 MiB chunked, reordering, IBB both
directions, `httpxFetch` bridge), `abort.test.ts` (AbortSignal / cancel /
close propagation), `sipub.test.ts` / `jingle.test.ts` (handshakes, expiry,
peer binding, decline paths, duplicate-initiate hedge), `caps.test.ts`
(presence-learned capabilities, one-query-per-ver).

## E2E against Prosody (`test/e2e/`)

Gated behind `E2E=1` (the vitest project isn't even constructed without it).
`global-setup.ts` runs `docker compose up -d --wait`, registers `alice` and
`bob` via `prosodyctl register`, and tears everything down after
(`E2E_KEEP=1` keeps the container for debugging).

| Piece | Value |
|---|---|
| Image | `prosodyim/prosody:13.0` |
| Host ports | 15222 (c2s), **15280 (websocket — the tested transport)**, 15347 (component) |
| Users | `alice` / `e2e-alice`, `bob` / `e2e-bob` on `localhost` |
| Component | `httpx.localhost`, secret `e2e-secret` |

Config quirks captured in `prosody/prosody.cfg.lua` (both were found the
hard way): `pidfile` must be set or the `prosodyctl status` healthcheck
fails, and `http_interfaces = { "*", "::" }` is required or the websocket
listener binds loopback-only inside the container. Clients connect over
`ws://localhost:15280/xmpp-websocket` — no TLS, which sidesteps xmpp.js's
self-signed-STARTTLS pain *and* exercises the same transport the
WebExtension uses.

Suites: `c2s-roundtrip.e2e.test.ts` (inline/IBB/chunked/sipub/jingle bodies
between two real users — the sipub/jingle cases connect extra `bob`
resources because one session supports one `HttpxServer`) and
`component-gateway.e2e.test.ts` (`httpxFetch` → XEP-0114 component serving
`demo-site.ts`).

## Manual demo path

`scripts/demo-gateway.mjs` connects to the E2E Prosody's component and
serves a small multi-page site (pages, relative links, a PNG) over httpx —
browsable with the WebExtension, or scriptable with `httpxFetch`. See
[`examples/webext/README.md`](../examples/webext/README.md) for the
step-by-step.

## CI (`.github/workflows/ci.yml`)

| Job | Trigger | Runs |
|---|---|---|
| `check` | push/PR | lint, typecheck, build |
| `test` | push/PR | node project on Node 20 / 22 / 24 |
| `browser` | push/PR | Playwright Chromium, browser project |
| `e2e` | nightly cron, manual dispatch, pushes to main | Prosody compose + e2e project |
