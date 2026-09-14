# The Dillo plugin: httpx as a dpi

`examples/dillo/` gives [Dillo](https://dillo-browser.github.io/) an
`httpx://` scheme through its plugin interface, the dpi. It is the third
browser in this repository after the WebExtension and the Electron shell,
and the smallest by far, because Dillo already does the two hard things
the others had to arrange for themselves.

## Why Dillo is an easy host

| | WebExtension | Electron shell | Dillo dpi |
|---|---|---|---|
| Who fetches subresources | the extension, by hand, into `blob:` URLs | Chromium, through `protocol.handle` | Dillo, through the same dpi; `<img src="img/logo.png">` on an httpx page is one more `open_url` |
| Script execution | refused by DOMPurify + a scriptless sandbox | refused by CSP | there is none: Dillo has no JavaScript engine |
| Rendering | sanitized markup in a sandboxed iframe | Chromium | Dillo's own HTML/CSS engine |
| Connection lifetime | the extension page's | the app's | the plugin process's, from first request to `DpiBye` |

The security work in the extension (sanitizing, blob substitution, sandbox
flags) has no counterpart here. The plugin maps one protocol onto another
and nothing else. Its whole content-side surface is `formatHead()`: status
line and headers copied from the `Response`, hop-by-hop headers dropped.

## How Dillo routes a scheme to a plugin

Dillo treats every scheme it does not implement itself as a plugin's
(`Capi_url_uses_dpi` in `src/capi.c`): `httpx://…` becomes a request for the
service named `proto.httpx`. dpid, the plugin daemon Dillo starts on demand,
resolves that name through `~/.dillo/dpidrc`:

```
proto.httpx=httpx/httpx.dpi
```

and finds the program under `~/.dillo/dpi/httpx/` (the user directory wins
over the system one). A plugin whose file name contains `.filter` is run
once per request on the connection itself; ours is a server plugin, so
dpid starts it once, with a listening loopback TCP socket dup2()'d onto
fd 0, and connects to that socket for every request afterwards
(`dpid/main.c`, `start_server_plugin`). In Node that is one line:
`server.listen({ fd: 0 })`.

Being a server is the point. A filter would sign in to XMPP (TCP or
WebSocket, TLS, SASL, resource binding) for every page *and every image*;
the server keeps one session and pays one IQ round-trip per load.

## The protocol on one connection

dpip (`dpip/dpip.c`) is tags of single-quoted attributes, quotes doubled,
terminated by the three bytes ` '>`:

```
Dillo → plugin   <cmd='auth' msg='4d01ab14…' '>
Dillo → plugin   <cmd='open_url' url='httpx://web@httpx.localhost/' '>
plugin → Dillo   <cmd='send_status_message' msg='httpx: signing in as alice@localhost…' '>   (optional)
plugin → Dillo   <cmd='start_send_page' url='httpx://web@httpx.localhost/' '>
plugin → Dillo   HTTP/1.1 200 OK\r\n
                 content-type: text/html; charset=utf-8\r\n
                 \r\n
                 <!doctype html>…            (raw to EOF)
```

- `auth` carries the shared secret dpid wrote to
  `~/.dillo/dpid_comm_keys` (`<port> <hex>`); the plugin reads the file on
  every check, as `a_Dpip_check_auth` does, because the key changes when
  dpid restarts and the plugin may outlive one. A wrong secret closes the
  connection without a byte.
- After `start_send_page` Dillo switches to raw mode and feeds the rest
  to its cache as an HTTP response (`src/IO/dpi.c`, then `src/cache.c`). So
  status codes, `Content-Type`, `Content-Length` and `Location` all keep
  their web meaning: a 404 is a 404 page, a 302 redirects. Dillo's cache
  checks `HTTP/1.0` vs `1.1` only for keep-alive semantics that do not apply.
- `DpiBye`, on its own authenticated connection, is dpid saying stop:
  `dpidc stop`, `dpidc register` (re-reading dpidrc), or Dillo exiting.

The framing lives in `examples/dillo/src/dpip.ts` (`buildTag`, `parseTag`,
an incremental `TagBuffer`) and the per-connection choreography in
`src/serve.ts`, which takes its `fetch` as a parameter. That is what lets
`test/integration-node/dillo-dpi.test.ts` drive the exact bytes over the
in-memory session pair, with no Dillo, dpid or Prosody.

## Failure pages

A fetch that fails becomes a page rather than a dropped connection, because
Dillo shows a dropped connection as nothing at all:

| cause | status | page |
|---|---|---|
| no `~/.dillo/httpx.json`, or sign-in refused (`DpiSetupError`) | 503 | what to fix, with the path |
| the server refused the JID (`HttpxError` `forbidden`) | 403 | the server's message, and a hint |
| any other `HttpxError` | its `httpEquivalent` | the message |
| Dillo sent a non-httpx URL here | 400 | "Not an httpx address" |

Messages are escaped on the way into the page; the server's error text is
the one hostile string that reaches Dillo's renderer through this path.

## What was verified

`npm run smoke:dillo` (`scripts/smoke-dillo.mjs`) installs into a throwaway
`$HOME`, starts a real dpid, and speaks to it as Dillo does (`check_server`
for `proto.httpx`, connect to the port it answers with, `auth`, `open_url`)
against the demo gateway over Prosody. That proves the parts the unit suite
cannot: the dpidrc line routes the scheme, dpid execs the launcher and the
plugin really does inherit the listening socket on fd 0, and one sign-in
serves the page, its image and a 404. Then, where `dillo` and `xvfb-run`
exist, Dillo itself loads the page under Xvfb; the plugin's log shows Dillo
requesting `/` and then `img/logo.png` on its own, and
`examples/dillo/dist/smoke-dillo.png` shows the demo page rendered with its
stylesheet. Run on 2026-09-12 with Dillo 3.0.5 and dpid 3.2.0.

## Limits, all Dillo's

- No POST. `Capi_dpi_build_cmd` hands a plugin `cmd` and `url` only, so a
  form body never reaches it. GET forms work since the query is in the
  URL. (Dillo's own `https` plugin had the same limit until TLS moved into
  the browser.)
- No revalidation. Dillo does not send `If-None-Match` to plugins, so
  every load is a full fetch; the plugin adds no cache of its own, since
  Dillo caches the rendered response for the session.
- The account is global. One JID browses everything; a URL's userinfo
  names the *server* JID, as XEP-0332 defines it, never the account.
- Any page can trigger a fetch. An `<img src="httpx://…">` on an http
  page makes Dillo request it through the plugin with the user's XMPP
  identity. That is the same standing as any scheme handler, and the same
  accepted risk the Electron shell and the OS-handler note document.

## Not done here

- Packaging. The launcher bakes in the absolute paths of `node` and the
  checkout; a distributable plugin would bundle the code and pick up node
  from a known place. `install.sh` is the honest version for now.
- A settings page. Dillo plugins can serve pages of their own
  (`dpi:/httpx/`); an account form there, writing `httpx.json`, would spare
  the text editor. Small, and not needed to prove the scheme works.
