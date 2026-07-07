# Releasing — owner runbook

Two actions create public surfaces and therefore need the owner's hands
(and credentials). Everything below them is already prepared and verified.

## 1. Create the GitHub repository and push (one time)

```sh
# From the repo root; gh is already authenticated as ooguz.
gh repo create xmpp-httpx --public \
  --description "XEP-0332 HTTP over XMPP Transport for TypeScript — all seven body transports, client + server, Node and browsers, with a WebExtension httpx:// browser" \
  --source . --push
git push origin v0.5.0

# Enable GitHub Pages driven by the CI workflow (for the typedoc site):
gh api repos/ooguz/xmpp-httpx/pages -X POST -f build_type=workflow
```

What activates on push: the four CI jobs (lint/typecheck/build; Node
20/22/24 tests; headless-Chromium tests; nightly Prosody E2E) plus the
`api-docs` job deploying typedoc to <https://ooguz.github.io/xmpp-httpx/>.
The README badges and package.json `repository`/`homepage`/`bugs` already
point at `ooguz/xmpp-httpx` — if you pick another name/org, update those
first (`README.md`, `package.json`, `typedoc.json`, `docs/ROADMAP.md`,
`docs/xep-0332-feedback.md`).

## 2. Publish to npm

```sh
npm login
npm publish        # prepublishOnly runs lint + typecheck + tests + build
```

The tarball was inspected with `npm pack --dry-run`: `dist/` + `src/` +
README/LICENSE/CHANGELOG, ~95 kB. The package is unscoped, so it is public
by default. Consider `npm publish --provenance` once publishing from CI.

## 3. Announce (optional, when ready)

- Post `docs/xep-0332-feedback.md` to <standards@xmpp.org> — it is written
  as a ready-to-send implementation-experience report proposing XEP-0332
  return to Experimental with fixes.
- Add the implementation to the XMPP software listing / XEP-0332 wiki notes.

## Release checklist (future versions)

1. Update `CHANGELOG.md`; bump `package.json` version.
2. `npm run lint && npm run typecheck && npm test && npm run test:browser`
   and, with Docker, `npm run test:e2e`.
3. Commit, `git tag -a vX.Y.Z -m "…"`, push with `--tags`.
4. `npm publish`.
