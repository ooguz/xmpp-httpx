# httpx for Dillo

A Dillo plugin (dpi) that browses `httpx://` URLs, HTTP carried over XMPP
as XEP-0332 defines it. Built from `examples/dillo/` in
<https://github.com/ooguz/xmpp-httpx>; that directory's README and
`docs/dillo-plugin.md` there have the full story.

## Requirements

- Dillo 3.0.5 or newer, with `dpid` and `dpidc` on PATH (they come with it).
- Node.js 20 or newer. The launcher looks on PATH, then under `~/.nvm`,
  then in the usual system places; `HTTPX_DPI_NODE=/path/to/node` overrides.
- An XMPP account. `httpx.json.example` holds the demo account used by the
  project's `npm run demo` Prosody; replace it with yours.

## Install

```sh
sh install.sh
```

This copies the plugin to `~/.local/share/httpx-dpi/httpx.js`, the launcher
to `~/.dillo/dpi/httpx/httpx.dpi`, adds `proto.httpx=httpx/httpx.dpi` to
`~/.dillo/dpidrc`, and writes `~/.dillo/httpx.json` from the example if you
have none. Then, in Dillo, open `dpi:/httpx/` to enter your account, or edit
`~/.dillo/httpx.json` by hand:

```json
{
  "jid": "alice@example.org",
  "password": "…",
  "service": "wss://example.org/xmpp-websocket",
  "resource": "dillo",
  "timeoutMs": 30000
}
```

`service` is optional. The file is plaintext, mode 600, re-read on every
sign-in.

## Remove

```sh
sh install.sh --uninstall
```

Your `~/.dillo/httpx.json` is left in place.

## What Dillo cannot do through a plugin

POST (a plugin receives only the URL, so GET forms work and POST forms do
not) and conditional requests (every load is a full fetch).

## License

AGPL-3.0-only, like xmpp-httpx. The bundle contains xmpp-httpx and its
dependencies (`@xmpp/*`, `ltx`, `ws` and friends); their licenses are in
`LICENSES.txt`.
