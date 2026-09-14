# `xmpp-httpx-gateway`: putting a website on XMPP

The gateway CLI connects to XMPP, answers XEP-0332 requests, and serves them
from either an ordinary HTTP origin (`--origin`) or a directory on disk
(`--static`). Your site keeps running as it is; XMPP becomes an additional way
in.

```sh
XMPP_HTTPX_SECRET=… npx xmpp-httpx-gateway \
  --origin http://localhost:8080 \
  --service xmpp://xmpp.example.org:5347 \
  --domain web.example.org \
  --allow alice@example.org
```

Requests then reach `httpx://web.example.org/…` from anywhere on the XMPP
network. The WebExtension browser in `examples/webext/` is one client and
`httpxFetch` is another.

## The two modes

| Mode | Flags | What it is |
|---|---|---|
| **Component** | `--domain` + `--secret` | XEP-0114: the gateway *is* a subdomain of your XMPP server. Requests go to `httpx://web.example.org/`. Needs a `component` entry in the server's config. |
| **Client** | `--jid` + `--password` | A normal account. Requests go to `httpx://user@example.org/`. Needs no server-side configuration at all, which makes it useful for trying things out, or for serving from an account you already have. |

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

Precedence: flags > environment > config file > defaults. So a deployment can
keep a checked-in config file and override one value per environment, and secrets
can come from `XMPP_HTTPX_SECRET` / `XMPP_HTTPX_PASSWORD` while everything else
stays in the file. Passing `--secret`/`--password` on the command line works but
prints a warning: argv is readable by other processes on most systems.

## What the origin sees

Every proxied request carries the requester's full, SASL-authenticated JID in
`X-Httpx-From` (rename with `--jid-header`, drop with `--no-jid-header`), plus
their bare JID in `X-Forwarded-For`. That header is the httpx replacement for
cookies and Basic auth: the XMPP server verified the identity, so the origin can
trust it, provided the origin is only reachable by the gateway. Bind it to
localhost or a private network; a public origin could be sent a forged
`X-Httpx-From` by anyone. See [architecture.md](architecture.md) for the
authentication model.

Hop-by-hop headers are stripped both ways. Redirects are forwarded to the client
by default, or followed at the gateway with `--follow-redirects`.

## Tuning

- `--max-stanza <bytes>` derives inline and chunk budgets from your server's
  stanza limit via `stanzaBudgets()`. Worth setting: the default budgets are
  conservative because the limit is not discoverable from the client side.
- `--prefer ibb,chunkedBase64` sets the stream mechanism preference for large
  bodies.
- `--max-body <bytes>` caps request bodies (default 8 MiB).
- `--no-compress` disables transparent gzip/deflate.

## Running it for real

`SIGINT`/`SIGTERM` shut the XMPP stream down cleanly rather than dropping the
socket, so a supervisor (systemd, Docker, k8s) can restart it without the server
waiting on a dead connection. Requests are logged one line each
(`from method resource → status (ms)`); see Observability below for JSON logs and
metrics.

The CLI ships as a `bin` of the main package, so `npx xmpp-httpx-gateway` works
without a global install. It needs `@xmpp/component` (or `@xmpp/client`)
present; those are optional peers of the library. If one is missing, the CLI
says exactly which one to install instead of printing a stack trace.

## Serving a directory instead of an origin

`--static <dir>` drops the HTTP server entirely, so there is no nginx, no origin
process, and one container instead of two:

```sh
XMPP_HTTPX_SECRET=... xmpp-httpx-gateway \
  --static /srv/site --service xmpp://xmpp.example.org:5347 \
  --domain web.example.org --allow-all
```

It serves `index.html` for directories, types files by extension, streams bodies
(so a large file is never held in memory), and answers `HEAD`. Anything other
than GET/HEAD gets a 405, since a static site has nothing to change.

Every response carries `ETag` and `Last-Modified`, plus `Cache-Control:
max-age=60` (tune with `--static-max-age`, `0` to omit). Those validators are
the point: revalidation costs a 304 with no body, and on this transport the
body is the expensive part.

Path safety is checked twice, because request paths come off the network:

1. Lexically, after percent-decoding, so `%2e%2e%2f` cannot smuggle segments
   past the check. Note that `..` in an absolute path collapses rather than
   escaping: `/../secret` means `<root>/secret`, exactly as an HTTP server
   treats it, so traversal attempts surface as 404s.
2. Against the real path, because `resolve()` does not follow symlinks. A
   link inside the root pointing at `/etc/ssl` is refused with a 403 rather than
   served, and the check compares real paths on both sides so a root under a
   symlinked parent (`/tmp` -> `/private/tmp`) still works.

## Rate limiting

Off unless asked for. `--rate <per-second>` gives each bare JID a token
bucket; `--burst <n>` sets how many requests may arrive at once (default
`ceil(rate)`):

```sh
xmpp-httpx-gateway --static /srv/site --service ... --domain ... --allow-all \
  --rate 5 --burst 20
```

A throttled request gets a real 429 with `Retry-After`, not a 403:

```
#1 -> 200
#2 -> 200
#3 -> 429 retry-after=1   rate limit exceeded; retry in 1s
```

A few details about how it is built:

- The limiter is a handler wrapper rather than an `authorize` hook, even though
  the roadmap filed it under "in front of authorize". `AuthorizeFn` can only say
  yes or no, and the server renders a no as `forbidden`. A throttled client
  should be told to slow down and when to come back, which only a 429 with
  `Retry-After` can express. It costs nothing extra: the server hands the
  handler an unread body stream, so refusing here still skips both the origin
  call and reading the request.
- The bucket is keyed on the bare JID. Resources are free to mint, so
  limiting `alice@example.org/laptop` separately from `/phone` would let one
  account multiply its own quota at will.
- The tracking map is bounded (`maxTracked`, 10 000 by default). When it is
  full the least recently seen bucket is dropped, which at worst gives that
  sender a fresh allowance. It never produces an error, and a flood of distinct
  senders cannot grow the map without bound.

Refusals are logged and counted (`httpx_gateway_rate_limited_total`, by bare
JID), and because a 429 is a response it also lands in
`httpx_gateway_requests_total{status="429"}`.

The limiter is exported, so a server built outside the CLI can use it too:

```js
import { HttpxServer, withRateLimit } from "xmpp-httpx";

server.handle(withRateLimit(myHandler, { ratePerSecond: 5, burst: 20 }));
```

## Observability

### Logs

`--log-format text` (default) is one line per event, the request line staying
compact:

```
[gateway] alice@example.org/laptop GET /page → 200 (12ms)
```

`--log-format json` emits one object per line, with the fields as data rather
than interpolated into a sentence, so a log shipper can index `status` and
`durationMs`:

```json
{"ts":"2026-07-30T20:16:59.024Z","level":"info","msg":"request","from":"alice@example.org/laptop","method":"GET","resource":"/page","status":200,"durationMs":23}
```

Errors carry `error`, `errorName` and (when present) `cause`. `--quiet` keeps
errors only; both formats write info to stdout and errors to stderr.

### Metrics and health

`--metrics-port 9100` starts the gateway's only listening socket, serving:

| Path | What |
|---|---|
| `/metrics` | Prometheus text format |
| `/healthz` | 200 while the XMPP stream is up, 503 otherwise |

It binds 127.0.0.1 by default, deliberately: the metrics label denied JIDs, and
that is not something to publish by accident. `--metrics-address 0.0.0.0` opens
it up when a scraper needs to reach it from elsewhere.

```
httpx_gateway_build_info{version="0.6.0"} 1
httpx_gateway_stream_up 1
httpx_gateway_requests_total{method="GET",status="200"} 3
httpx_gateway_requests_denied_total{jid="eve@example.org"} 1
httpx_gateway_errors_total{kind="origin"} 1
httpx_gateway_request_duration_seconds_bucket{le="0.05"} 2
httpx_gateway_request_duration_seconds_sum 0.061
httpx_gateway_request_duration_seconds_count 3
```

Two deliberate choices in there:

- Denials are labelled by bare JID, never the full one: a resource is
  unbounded cardinality, and metrics are not an audit log. The request log has
  the full JID.
- `httpx_gateway_stream_up` is the only real liveness fact the gateway has: it
  serves no port for requests, so "can it reach XMPP" is its health. That is
  what `/healthz` reports, and what makes a container healthcheck possible.

The registry is hand-rolled (~80 lines) rather than pulling in a Prometheus
client: this package ships with one runtime dependency and the CLI should not
change that.

## Docker

The repo's [`Dockerfile`](../Dockerfile) builds the gateway as a container. Its
build stage produces a tarball with `npm pack` and the runtime stage installs
that tarball, so the image runs the exact artifact `npm publish` would upload,
and a packaging mistake fails the build instead of shipping. `@xmpp/client` and
`@xmpp/component` are installed alongside it, since they are optional peers of
the library and both modes should work out of the box.

```sh
docker build -t xmpp-httpx-gateway .
docker run --rm -e XMPP_HTTPX_SECRET=… xmpp-httpx-gateway \
  --origin http://origin:8080 --service xmpp://prosody:5347 \
  --domain web.example.org --allow alice@example.org
```

The image runs as the non-root `node` user, is ~170 MB on `node:24-alpine`, and
propagates exit codes (2 for a bad configuration, 1 for a failed start) so an
orchestrator can tell a crash from a misconfiguration. `docker stop` sends
SIGTERM, which the CLI handles by closing the XMPP stream and exiting 0. No
init shim is needed even with node as PID 1, and there is no kill-timeout wait.

The image declares no `HEALTHCHECK`, because whether one is possible depends on
the configuration: with `--metrics-port` set, `/healthz` makes it a one-liner
(`wget -q -O /dev/null http://127.0.0.1:9100/healthz`), but baking that in would
mark a perfectly healthy gateway unhealthy when metrics are switched off.
[`examples/docker/`](../examples/docker/) wires it up at the compose level, where
the config is known, probing loopback inside the container so the endpoints
stay off the network.

[`examples/docker/`](../examples/docker/) is a runnable three-container
deployment (nginx origin + Prosody + this gateway) with the origin deliberately
unreachable from the host, which is what makes `X-Httpx-From` trustworthy to it.
Two commands get you to a browsable `httpx://web.localhost/`.

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
that is not on the allowlist is refused before the origin is ever contacted.
