# Interoperability matrix

xmpp-httpx is currently its own interop anchor — there is no other known
maintained XEP-0332 implementation. This page tracks what the library has
been exercised against. Reports (issues/PRs) for other servers and clients
are very welcome; the E2E suite (`docs/testing.md`) is designed to be
pointed at other backends with minimal changes.

## XMPP servers (as the connection substrate)

| Server | Version | c2s (WebSocket) | Component (XEP-0114) | Notes |
|---|---|---|---|---|
| Prosody | 13.0 (docker `prosodyim/prosody:13.0`) | ✅ tested in CI | ✅ tested in CI | Needs `pidfile` for healthchecks and `http_interfaces = {"*"}` in containers — see `test/e2e/prosody/prosody.cfg.lua` |
| ejabberd | — | ❓ untested | ❓ untested | Expected to work (plain IQ/message routing); reports welcome |
| Openfire | — | ❓ untested | ❓ untested | |
| Tigase | — | ❓ untested | ❓ untested | |

What "tested" covers: inline (`text`/`xml`/`base64`), `chunkedBase64`, IBB,
sipub, and jingle bodies in both directions, between two c2s users and
through a component gateway, over `ws://` transport.

## XEP-0332 peer implementations

| Implementation | Status |
|---|---|
| xmpp-httpx ↔ xmpp-httpx | ✅ continuously (mock pair, headless Chromium, live Prosody) |
| Clayster (the XEP author's stack, referenced in the XEP's examples) | ❓ no known public endpoint — pointers appreciated |
| Anything else | none known as of 2026-07 |

## Runtimes

| Runtime | Status |
|---|---|
| Node.js 20 / 22 / 24 | ✅ CI matrix |
| Chromium (headless, Playwright) | ✅ full suite in CI |
| Firefox | ✅ manually via the WebExtension (`examples/webext/`) |
| Safari | ❓ untested (`iterateStream` shim exists for its ReadableStream) |

## How to add a row

1. Point `test/e2e/` at your server (compose file + `prosody.cfg.lua`
   equivalent; the suites only need two user accounts and a component
   binding — override the constants in `test/e2e/e2e-env.ts`).
2. Run `E2E=1 npm run test:e2e`.
3. Open an issue titled `interop: <server> <version>` with the output.
