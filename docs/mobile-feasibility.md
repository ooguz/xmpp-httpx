# Would this run on mobile?

A note, not a plan: what it would take to use this library from React Native,
and where it stops. Nothing here is built.

## The library itself: fine

The core is deliberately browser-safe (no `Buffer`, no `process`, no Node
built-ins outside `src/node/`) and ESM. Everything it needs from the runtime
is in React Native's Hermes engine plus polyfills already common in that
ecosystem:

| Needs | React Native |
|---|---|
| `TextEncoder`/`TextDecoder` | Hermes has them |
| `btoa`/`atob` | present; the library also ships its own base64 |
| `ReadableStream` | missing; needs `web-streams-polyfill` |
| `Headers`, `Response`, `Request` | partial (RN's fetch is XHR-backed); needs a polyfill for full `Response` streaming |
| `CompressionStream` | missing; Content-Encoding would have to be disabled (`compress: false`) |
| `crypto.subtle` (XEP-0115 caps hashing) | missing; needs `react-native-quick-crypto` or equivalent |

Streaming is the interesting one. The whole point of the IBB and chunked
transports is progressive bodies, and without a real `ReadableStream` the
polyfill's performance becomes the ceiling. For page-sized payloads it would
not matter; for large downloads it would.

## The transport: the real question

`@xmpp/client` needs a WebSocket, which React Native has, so a c2s connection
over `wss://` should work, and that is the same transport the WebExtension
uses. What React Native does *not* have is raw TCP, so:

- Direct TCP (5222) is out without a native module. No loss, since `wss://`
  is what a mobile client wants anyway.
- SOCKS5 bytestreams are out for the same reason (`src/node/socks5.ts` is
  Node-only by construction). IBB remains, which is the fallback path anyway.

xmpp.js's browser build resolves `@xmpp/websocket` and stubs the Node
transports; a bundler configured for React Native should follow the same
`browser` fields, but that is the first thing to verify rather than assume.

## The rendering problem, which is the actual blocker

A mobile *httpx browser* needs to display fetched HTML. The options are all
unattractive:

- `react-native-webview` can render a string of HTML, so the extension's
  sanitize-then-`srcdoc` pipeline ports almost directly, but subresources are
  the same manual dance as in the extension (fetch over httpx, rewrite to
  `data:`/`blob:` URLs), and a WebView cannot be given a custom scheme handler
  the way Electron's `protocol.handle` can. On Android, `shouldInterceptRequest`
  gets close; on iOS, `WKURLSchemeHandler` does the same job as Electron's, so
  the answer differs per platform.
- Native rendering (mapping HTML to RN components) is a project of its own.

So a mobile client is plausible for *fetching* httpx (an app that reads httpx
APIs, or a chat client that renders httpx-served content in a WebView), while
a real mobile *browser* is only sensible on iOS via `WKURLSchemeHandler` and
on Android via `shouldInterceptRequest`, both of which are native work.

## Conclusion

- Using `xmpp-httpx` as a client library on React Native is likely a
  polyfill-and-verify exercise, worth an afternoon if someone wants it.
- Shipping a mobile httpx browser is a per-platform native project rather
  than a port of the extension.
- Nothing in the library needs to change for either, which is why this stays
  a note.
