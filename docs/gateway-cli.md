# `xmpp-httpx-gateway` — putting a website on XMPP

The gateway CLI is `createOriginProxyHandler` with a face: it connects to XMPP,
answers XEP-0332 requests, and forwards them to an ordinary HTTP origin. Your
site keeps running as it is; XMPP becomes an additional way in.

```sh
XMPP_HTTPX_SECRET=… npx xmpp-httpx-gateway \
  --origin http://localhost:8080 \
  --service xmpp://xmpp.example.org:5347 \
  --domain web.example.org \
  --allow alice@example.org
```

Requests then reach `httpx://web.example.org/…` from anywhere on the XMPP
network — the WebExtension browser in `examples/webext/` is one client,
`httpxFetch` is another.

## The two modes

| Mode | Flags | What it is |
|---|---|---|
| **Component** | `--domain` + `--secret` | XEP-0114: the gateway *is* a subdomain of your XMPP server. Requests go to `httpx://web.example.org/`. Needs a `component` entry in the server's config. |
| **Client** | `--jid` + `--password` | A normal account. Requests go to `httpx://user@example.org/`. Needs no server-side configuration at all — useful for trying things out, or for serving from an account you already have. |

Component mode is the deployment shape; client mode is the "I want to see this
work in five minutes" shape.

## Authorization is never implicit

The library denies unknown requesters by default, and the CLI refuses to start
without an explicit decision:

```
--allow alice@example.org,bob@example.org    # repeatable; bare JIDs
--allow-all                                  # a public gateway, spelled out
```

There is deliberately no default. A gateway that silently served the whole
federated network because a flag was forgotten would be the worst failure this
tool could have.

## Configuration file

Everything can live in a JSON file instead of on the command line, which is also
how to keep secrets out of `ps`:

```json
{
  "service": "xmpp://xmpp.example.org:5347",
  "domain": "web.example.org",
  "secret": "…",
  "origin": "http://localhost:8080",
  "allow": ["alice@example.org", "bob@example.org"],
  "maxStanzaBytes": 65536,
  "preferredStreams": ["ibb", "chunkedBase64"],
  "compress": true,
  "jidHeader": "x-httpx-from",
  "maxRequestBodyBytes": 8388608
}
```

```sh
xmpp-httpx-gateway --config gateway.json
```

`"allow": "all"` is the file spelling of `--allow-all`.

**Precedence: flags > environment > config file > defaults.** So a deployment can
keep a checked-in config file and override one value per environment, and secrets
can come from `XMPP_HTTPX_SECRET` / `XMPP_HTTPX_PASSWORD` while everything else
stays in the file. Passing `--secret`/`--password` on the command line works but
prints a warning: argv is readable by other processes on most systems.

## What the origin sees

Every proxied request carries the requester's **full, SASL-authenticated JID**
in `X-Httpx-From` (rename with `--jid-header`, drop with `--no-jid-header`), plus
their bare JID in `X-Forwarded-For`. That header is the httpx replacement for
cookies and Basic auth: the XMPP server verified the identity, so the origin can
trust it — *provided* the origin is only reachable by the gateway. Bind it to
localhost or a private network; a public origin could be sent a forged
`X-Httpx-From` by anyone. See [architecture.md](architecture.md) for the
authentication model.

Hop-by-hop headers are stripped both ways. Redirects are forwarded to the client
by default, or followed at the gateway with `--follow-redirects`.

## Tuning

- `--max-stanza <bytes>` — derive inline and chunk budgets from your server's
  stanza limit via `stanzaBudgets()`. Worth setting: the default budgets are
  conservative because the limit is not discoverable from the client side.
- `--prefer ibb,chunkedBase64` — stream mechanism preference for large bodies.
- `--max-body <bytes>` — cap on request bodies (default 8 MiB).
- `--no-compress` — disable transparent gzip/deflate.

## Running it for real

`SIGINT`/`SIGTERM` shut the XMPP stream down cleanly rather than dropping the
socket, so a supervisor (systemd, Docker, k8s) can restart it without the server
waiting on a dead connection. Requests are logged one line each
(`from method resource → status (ms)`); `--quiet` keeps only errors. Structured
logs and metrics are a separate roadmap item.

The CLI ships as a `bin` of the main package, so `npx xmpp-httpx-gateway` works
without a global install. It needs `@xmpp/component` (or `@xmpp/client`) present
— those are optional peers of the library, and the CLI says exactly which one to
install if it is missing rather than printing a stack trace.

## Trying it against the repo's Prosody

```sh
docker compose -f test/e2e/docker-compose.yml up -d --wait
npm run build
node -e 'require("node:http").createServer((q,s)=>s.end("<h1>hi</h1>")).listen(8080)' &
XMPP_HTTPX_SECRET=e2e-secret node bin/xmpp-httpx-gateway.mjs \
  --origin http://localhost:8080 --service xmpp://localhost:15347 \
  --domain httpx.localhost --allow alice@localhost
```

Then browse `httpx://httpx.localhost/` with the WebExtension, or fetch it with
`httpxFetch`. The E2E suite does exactly this in
`test/e2e/cli-gateway.e2e.test.ts`, including the case that matters most: a JID
that is *not* on the allowlist is refused before the origin is ever contacted.
