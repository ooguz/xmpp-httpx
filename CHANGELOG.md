# Changelog

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
