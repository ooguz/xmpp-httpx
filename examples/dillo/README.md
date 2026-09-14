# httpx for Dillo (a dpi plugin)

Teaches [Dillo](https://dillo-browser.github.io/) to browse `httpx://` URLs:
a server dpi that dpid starts on the first request and that keeps one
XMPP session signed in across page loads. Dillo renders the page itself, so
there is no sanitizer and no iframe here. Dillo has no JavaScript to keep
out, and its own HTML/CSS engine does the drawing. Architecture and the
protocol notes: [docs/dillo-plugin.md](../../docs/dillo-plugin.md).

Works with Dillo 3.0.5 (Debian/Ubuntu's package) and 3.2.x; the plugin
protocol has not changed between them.

## Install

```sh
npm install                # links xmpp-httpx from ../..
npm run install:dillo      # builds, then writes the three files below
```

`install.sh` puts, under `~/.dillo/`:

| file | what for |
|---|---|
| `dpi/httpx/httpx.dpi` | the program dpid execs: a two-line launcher that runs `dist/main.js` with the absolute path of your `node`, because dpid inherits Dillo's PATH rather than your shell's |
| `dpidrc` | `proto.httpx=httpx/httpx.dpi`, which is how the scheme reaches the plugin; created from the system file if you had none |
| `httpx.json` | your account (copied from `httpx.json.example` if missing) |

Then edit `~/.dillo/httpx.json`:

```json
{
  "jid": "alice@example.org",
  "password": "…",
  "service": "wss://example.org/xmpp-websocket",
  "resource": "dillo",
  "timeoutMs": 30000
}
```

`service` is optional; without it the domain is resolved the way any XMPP
client resolves it. The file is plaintext, like the `cookiesrc` next to it;
`install.sh` makes it mode 600 and that is the extent of the protection.
It is re-read on every sign-in, so editing it needs no restart.

Open `httpx://web.example.org/` in Dillo. The first load signs in (the status
bar says so); every load after that is one IQ round-trip.

`npm run uninstall:dillo` removes the launcher and the dpidrc line.

## Against the repo's demo site

```sh
cd ../.. && npm run demo     # Prosody + demo gateway, one command
```

The example config already holds the demo account (`alice@localhost` /
`e2e-alice`, `ws://localhost:15280/xmpp-websocket`); then in Dillo:

```
httpx://web@httpx.localhost/
```

## How it runs

- dpid starts it when Dillo first asks for `proto.httpx`, with a
  listening TCP socket on loopback already bound as stdin; the plugin
  accepts a connection per request on it. `HTTPX_DPI_LISTEN=127.0.0.1:0`
  listens on a port of its own instead, for running it by hand.
- Every connection authenticates with the shared secret from
  `~/.dillo/dpid_comm_keys`, as every Dillo plugin does.
- `DpiBye` from dpid (on `dpidc stop`, `dpidc register`, or Dillo's
  exit) closes the XMPP session and ends the process.
- Log lines go to stderr, which is Dillo's terminal:
  `[httpx.dpi] httpx://web@httpx.localhost/img/logo.png → 200 (4ms)`.

## What Dillo cannot do here

- POST. Dillo hands a plugin only the URL (`Capi_dpi_build_cmd` in
  `src/capi.c`); form bodies never reach it. GET forms work because the
  query rides in the URL.
- Conditional requests. Dillo's cache does not revalidate plugin
  content with `If-None-Match`; every load is a full fetch.
- Page-declared referers or cookies do not apply to plugin schemes.

## Verifying

```sh
cd ../.. && npm test -- dillo         # the framing, over the in-memory pair
npm run smoke:dillo                    # real dpid, real Dillo under Xvfb
```

The smoke script installs into a throwaway `$HOME`, starts a real `dpid`,
speaks to it exactly as Dillo does, then launches Dillo under Xvfb against
the demo gateway and saves `dist/smoke-dillo.png`. Verified this way with
Dillo 3.0.5 and dpid 3.2.0: the page and its image both travel through the
plugin, and the screenshot shows the demo page with its stylesheet applied.
