# A whole httpx deployment in three containers

This is the "put your website on XMPP" shape, running for real:

| Service | What it is |
|---|---|
| `origin` | An ordinary website (nginx serving `site/`). **Not published to the host** — only the gateway can reach it. |
| `prosody` | The XMPP server. c2s on 5222, websocket on 5280. |
| `gateway` | `xmpp-httpx-gateway` from the repo's [`Dockerfile`](../../Dockerfile), owning the component `web.localhost`. |

Nothing in `site/` knows about XMPP. The gateway fetches it over plain HTTP on
the internal network and forwards it inside stanzas.

## Run it

```sh
docker compose up -d --wait
docker compose exec prosody prosodyctl register alice localhost demo-password
```

That's it — `httpx://web.localhost/` is now served. To browse it:

1. Build the WebExtension: `npm --prefix ../webext run build` (from this
   directory) and load `examples/webext/dist/firefox` or `dist/chromium`.
2. In its settings: service `ws://localhost:5280/xmpp-websocket`, JID
   `alice@localhost`, password `demo-password`.
3. Navigate to `httpx://web.localhost/`.

Or fetch it from Node without a browser:

```js
import { client } from "@xmpp/client";
import { httpxFetch } from "xmpp-httpx";

const alice = client({
  service: "ws://localhost:5280/xmpp-websocket",
  domain: "localhost",
  username: "alice",
  password: "demo-password",
});
await alice.start();
const response = await httpxFetch("httpx://web.localhost/", { session: alice });
console.log(response.status, await response.text());
```

Watch it work: `docker compose logs -f gateway` prints one line per request.

```
[gateway] serving http://origin:80 as httpx://web.localhost/ (1 allowed JID(s))
[gateway] alice@localhost/probe GET / → 200 (34ms)
[gateway] alice@localhost/probe GET /missing → 404 (5ms)
```

## How it is wired

- **`gateway.json`** holds everything except the secret; `XMPP_HTTPX_SECRET` in
  `compose.yml` supplies that, so it never lands in the image or in `ps`. Flags
  would override both (`command: ["--config", "…", "--quiet"]`).
- **`allow: ["alice@localhost"]`** — only that JID is served. Try it as another
  account and the gateway refuses *before* the origin is contacted. Swap in
  `"allow": "all"` for a public gateway; there is deliberately no default.
- **`maxStanzaBytes: 65536`** derives inline/chunk budgets from what this Prosody
  accepts. Without it the library uses conservative defaults, since the limit is
  not discoverable from the client side.
- **`depends_on: service_healthy`** for both — the gateway exits non-zero on a
  failed XMPP connection, and `restart: unless-stopped` plus healthy
  dependencies is what keeps a restart loop from being the normal state.
- `docker compose stop` sends SIGTERM; the CLI closes the XMPP stream and exits
  0, so the server never waits on a dead connection.

## What is demo-grade here

`prosody.cfg.lua` allows **plaintext auth over an unencrypted websocket** so the
extension can connect without certificates, and the component secret is in a
file in this repo. Both are fine for a laptop and wrong for a deployment: use
`wss://`, a real authentication backend, and a secret from your orchestrator's
secret store (`XMPP_HTTPX_SECRET` is already the right shape for that).

The origin being unreachable from the host is *not* incidental — the gateway
tells the origin who is asking via `X-Httpx-From`, and that header is only
trustworthy because nothing else can talk to the origin. Keep it that way.

## Tear down

```sh
docker compose down
```
