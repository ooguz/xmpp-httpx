# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: the
"Report a vulnerability" button under the Security tab, or
<https://github.com/ooguz/xmpp-httpx/security/advisories/new>. Please do
not open a regular issue for a security finding.

Include what you can reproduce: the stanza, page or URL that triggers it,
the runtime (Node version, browser and version, or the Android app), and
what you observed. A proof of concept against the demo gateway or the
in-memory session pair (`xmpp-httpx/testing`) is ideal, since either can be
run without an XMPP account.

You will get an acknowledgement, then a fix or an explanation. There is no
bounty.

## What is in scope

- The library under `src/`: parsing of hostile stanzas, the stream
  transports (IBB, SOCKS5, Jingle), the server's authorization and body
  limits, the gateway CLI.
- The browsers under `examples/`: the WebExtension's rendering pipeline
  (sanitizer, CSS filter, sandbox, cache, downloads), the Electron shell's
  protocol handler, the Dillo plugin.

The threat model, the parts that most deserve hostile attention, the
findings already fixed and the risks accepted on purpose are written up in
[docs/security-review-dossier.md](docs/security-review-dossier.md). Reading
it first saves reporting something that is listed there as accepted.

## Supported versions

The latest release on `main`. Fixes land on `main` and ship in the next
version; there are no maintenance branches.
