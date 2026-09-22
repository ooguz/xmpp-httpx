# Releasing: owner runbook

Three actions create public surfaces and therefore need the owner's hands
(and credentials). Everything below them is already prepared and verified.

## 1. Create the GitHub repository and push (one time)

Done: `ooguz/xmpp-httpx` exists, is public since 2026-09-15, and has GitHub
Pages enabled from the workflow. Kept for reference:

```sh
# From the repo root; gh is already authenticated as ooguz.
gh repo create xmpp-httpx --public \
  --description "XEP-0332 HTTP over XMPP Transport for TypeScript — all seven body transports, client + server, Node and browsers, with a WebExtension httpx:// browser" \
  --source . --push
git push origin v0.9.0

# Enable GitHub Pages driven by the CI workflow (for the typedoc site):
gh api repos/ooguz/xmpp-httpx/pages -X POST -f build_type=workflow
```

What activates on push: the four CI jobs (lint/typecheck/build; Node
20/22/24 tests; headless-Chromium tests; nightly Prosody E2E) plus the
`api-docs` job deploying typedoc to <https://ooguz.github.io/xmpp-httpx/>.
The README badges and package.json `repository`/`homepage`/`bugs` already
point at `ooguz/xmpp-httpx`. If you pick another name/org, update those
first (`README.md`, `package.json`, `typedoc.json`, `docs/ROADMAP.md`).

## 2. Publish to npm

```sh
npm login
npm publish        # prepublishOnly runs lint + typecheck + tests + build
```

The tarball was inspected with `npm pack --dry-run`: `dist/` + `src/` +
README/LICENSE/CHANGELOG, ~95 kB. The package is unscoped, so it is public
by default. Consider `npm publish --provenance` once publishing from CI.

## 3. Sign and submit the browser extension

Firefox will not load an unsigned extension; Mozilla's server signs it.
Chrome signs on upload. Both start from `npm run package` in
`examples/webext/`, which writes the two store zips and the AMO source
archive into `dist/artifacts/`.

The add-on ID is `httpx-browser@ooguz.dev` (`scripts/make-manifests.mjs`).
AMO keys the add-on on it forever after the first signing, so it must not
change again.

### Firefox (AMO)

1. Developer Hub at <https://addons.mozilla.org/developers/>: create the
   account, then generate API credentials (a JWT issuer and secret).
2. Sign. `web-ext` reads the credentials from the environment, so they never
   appear on a command line or in shell history:

   ```sh
   export WEB_EXT_API_KEY='user:…:…'
   export WEB_EXT_API_SECRET='…'
   cd examples/webext && npm run package
   npm run sign:firefox                      # unlisted: a signed .xpi, no review
   WEB_EXT_CHANNEL=listed npm run sign:firefox   # listed on AMO, reviewed
   ```

   An unlisted signature is enough to install the `.xpi` anywhere, and it is
   the route for shipping the extension inside Berrak.
3. If AMO asks for sources (it does when the code is bundled), upload
   `dist/artifacts/httpx-browser-source-<version>.tar.gz`. It carries the
   library and extension sources plus a `BUILD.md` with the exact rebuild
   steps; reviewers rebuild and compare against the uploaded zip.

### Chrome Web Store

1. Register at <https://chrome.google.com/webstore/devconsole> (one-time
   fee). The first upload has to go through the console.
2. Upload `dist/artifacts/httpx-browser-chromium-<version>.zip`.
3. Fill in the privacy tab: single purpose (browse `httpx://` pages over the
   user's own XMPP account), the justification for `storage` (the account and
   history, kept locally), `downloads` (saving attachments) and the omnibox
   keyword, and the data-use declaration: nothing is collected or sent
   anywhere but the XMPP server the user configures.
4. Submit for review. Later versions can be uploaded from the command line
   with an OAuth client and `chrome-webstore-upload`.

The Android app (Berrak) is already signed with its own keystore, and the
Dillo plugin has no signing; its tarball goes on the GitHub release with a
checksum.

## 4. Announce (optional, when ready)

- Post the implementation-experience report to <standards@xmpp.org>. The
  draft lives at `docs/xep-0332-feedback.md` in the owner's checkout only
  (gitignored, not in the public repo); it proposes XEP-0332 return to
  Experimental with fixes.
- Add the implementation to the XMPP software listing / XEP-0332 wiki notes.

## Release checklist (future versions)

1. Update `CHANGELOG.md`; bump `package.json` version.
2. `npm run lint && npm run typecheck && npm test && npm run test:browser`
   and, with Docker, `npm run test:e2e`.
3. Commit, `git tag -a vX.Y.Z -m "…"`, push with `--tags`.
4. `npm publish`.
