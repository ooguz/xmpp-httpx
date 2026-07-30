# httpx desktop shell (Electron)

A desktop browser where **`httpx://` is a real scheme**: the address bar holds
it, Chromium fetches it, and subresources, forms, history and downloads all work
the way they do for `http`. Architecture and reasoning:
[docs/electron-shell.md](../../docs/electron-shell.md).

## Run it

```sh
npm install            # also links xmpp-httpx from ../..
npm start              # builds the library, compiles src/, launches Electron
```

To open a URL straight away — the same path an OS-level handler uses:

```sh
npm run build && npx electron . "httpx://web.example.org/"
```

On first launch the settings dialog asks for a WebSocket service, a JID and a
password; they are remembered in the app's user-data directory.

## Against the repo's demo site

```sh
cd ../.. && npm run demo          # Prosody + demo gateway, one command
```

Then, in another terminal:

```sh
npm start
# settings: ws://localhost:15280/xmpp-websocket, alice@localhost, e2e-alice
# address:  httpx://web@httpx.localhost/
```

Verified this way under Xvfb with Electron 38: the page renders with its own CSS,
and the image and CSS `background-image` are fetched over XMPP by Chromium
itself — the log shows both requests.

## Addressing

| You type | Chromium navigates | Why |
|---|---|---|
| `httpx://web.example.org/` | the same | a component domain is an ordinary authority |
| `httpx://alice@example.org/` | `httpx://alice--at--example.org/` | a `Request` URL **cannot carry credentials** (Fetch standard), so the JID's user part rides in the host |

The address bar shows the JID form either way. Account JIDs are best-effort —
localparts that a hostname cannot hold will not survive the trip — while
component domains need no encoding at all.

## What it does not do yet

- **No packaging**, so no `.desktop`/registry/plist registration —
  [docs/os-scheme-handlers.md](../../docs/os-scheme-handlers.md) has the details.
- **No response cache**: Chromium's HTTP cache does not cover a custom scheme.
- **Scripts are off** by default (`script-src 'none'` imposed by the protocol
  handler, overriding whatever the page asked for).
- **Credentials in plaintext** in the user-data directory, as in the extension.
