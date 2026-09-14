# `web+httpx` links from an ordinary website

Roadmap phase 10 asks whether a small companion website could register itself
as a handler for httpx links, so `web+httpx://…` links work in browsers where
the extension's `protocol_handlers` manifest key does not (i.e. Chromium).
This note records what the mechanism can and cannot do. It is a design note,
not an implementation; nothing in the repo depends on it.

## The mechanism

`navigator.registerProtocolHandler(scheme, url)` lets a page volunteer to
handle a scheme. The rules that matter here:

- The scheme must be `web+`-prefixed (`web+httpx`) unless it is one of the
  short safelist (`mailto:`, `bitcoin:`, `magnet:`, …). `httpx:` itself can
  never be registered this way: the safelist is fixed by the HTML spec, so a
  new scheme cannot join it without a spec change. That is the same wall the
  extension already hits, and it is why the address bar can never say `httpx`.
- The handler URL must be same-origin with the registering page and must
  contain exactly one `%s` placeholder, which receives the *percent-encoded*
  full URL.
- Registration requires a user gesture and shows a permission prompt; the
  user can decline, and both browsers remember the choice.
- The registering origin must be https (a secure context).

So a companion site at `https://httpx.example` could call

```js
navigator.registerProtocolHandler("web+httpx", "/open?target=%s");
```

after a click, and thereafter `web+httpx://server@example.org/page` links
anywhere in the browser would open `https://httpx.example/open?target=…`.

## Why this is not a substitute for the extension

The handler lands on a web page, not on the extension. That page cannot
open an XMPP connection on the user's behalf in any useful way:

- It has no access to the user's configured account; credentials live in the
  extension's `storage.local`, on a different origin.
- Even with credentials, a public web page holding a user's XMPP password is
  precisely the pattern this project avoids elsewhere (see the auth notes in
  [architecture.md](architecture.md)).

What the page *can* usefully do is hand off to the extension:

1. Decode `target`, validate it parses as an httpx URL (`parseHttpxUrl`).
2. Redirect to the extension page: `ext+httpx://…` on Firefox, or the
   extension's own URL on Chromium. The latter requires knowing the extension
   ID and having `web_accessible_resources` expose `browser.html`, i.e. the
   companion site and the extension must be built as a pair.
3. If the extension is not installed, explain what httpx is and link to the
   install page. This is arguably the most useful thing it does, since a
   naked `web+httpx` link is otherwise a dead end.

## Recommendation

Worth building only as part of publishing the extension to the stores, and
then mainly as a graceful-degradation and discovery page rather than as a real
entry point:

- Chromium gains clickable httpx links, which it cannot have otherwise.
- Firefox already has `protocol_handlers`, so the site adds nothing there
  except the not-installed explanation.
- The cost is a hosted origin plus a hard coupling to a published extension ID.

Until the extension is in the stores (phase 10, still owner-blocked on signing
credentials), there is nothing to hand off to, so this stays a note.

## Unverified in this environment

The rules above are from the HTML specification and browser documentation as
understood at the time of writing; the exact prompt wording, and whether a
given Chromium version still honors `registerProtocolHandler` from a page in
all release channels, were not re-tested here. Verify against a live
browser before shipping a companion site.
