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
npm run install:dillo      # packages, then runs the package's install.sh
```

Or, without a checkout, unpack `httpx-dillo-dpi-<version>.tar.gz` (built by
`npm run package` into `dist/artifacts/`) and run `sh install.sh` inside it.
The package is `install.sh`, the launcher `httpx.dpi`, the plugin bundled
into one file by esbuild (`lib/httpx.js`, about 250 KiB), the example
config, and `LICENSE` plus a `LICENSES.txt` assembled from the packages the
bundle actually contains. Its own README covers a user who never sees this
repository (`pkg/README.md` here).

`install.sh` puts:

| file | what for |
|---|---|
| `~/.local/share/httpx-dpi/httpx.js` | the plugin (`$XDG_DATA_HOME` is honored) |
| `~/.dillo/dpi/httpx/httpx.dpi` | the launcher dpid execs. It finds `node` at run time (PATH, then the newest under `~/.nvm`, then the usual system places; `HTTPX_DPI_NODE` overrides) and refuses anything older than Node 20, because dpid inherits Dillo's PATH rather than your shell's |
| `~/.dillo/dpidrc` | `proto.httpx=httpx/httpx.dpi`, which is how the scheme reaches the plugin; created from the system file if you had none |
| `~/.dillo/httpx.json` | your account (copied from `httpx.json.example` if missing) |

Then open `dpi:/httpx/` in Dillo: a status page with a settings form that
writes `~/.dillo/httpx.json` for you. Or edit the file by hand:

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
`install.sh` and the settings form write it mode 600 and that is the extent
of the protection. It is re-read on every sign-in, so editing it needs no
restart.

About the form: Dillo hands a plugin only a URL, so the form is a GET form
and its values, the password included, travel in the URL. They show in the
address bar and in the session's in-memory history (Dillo keeps no history
file), and the plugin never logs the query of a `dpi:` URL. An empty
password field keeps the stored password, so changing the service or
resource never re-sends it. If that trade-off is not for you, the file is
right there.

Open `httpx://web.example.org/` in Dillo. The first load signs in (the status
bar says so); every load after that is one IQ round-trip.

`npm run uninstall:dillo` (or the package's `sh install.sh --uninstall`)
removes the launcher, the bundle and the dpidrc line, and leaves
`httpx.json` in place.

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
- `dpi:/httpx/` is the plugin's own page: who it is signed in as, where the
  configuration lives, the settings form, and a sign-out link
  (`dpi:/httpx/reconnect`) that makes the next page sign in afresh. Dillo
  routes `dpi:/<name>/` URLs to the plugin registered under that name, and
  dpid registers ours as `httpx` from its directory name.

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
npm run smoke:dillo                    # the tarball, real dpid, real Dillo under Xvfb
```

The smoke script unpacks the tarball, runs its `install.sh` into a throwaway
`$HOME` (checking the launcher carries no path into the checkout), starts a real `dpid`,
speaks to it exactly as Dillo does, then launches Dillo under Xvfb against
the demo gateway and saves `dist/smoke-dillo.png`. Verified this way with
Dillo 3.0.5 and dpid 3.2.0: the page and its image both travel through the
plugin, and the screenshot shows the demo page with its stylesheet applied.
