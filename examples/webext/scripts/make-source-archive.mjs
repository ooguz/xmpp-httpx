// The source archive AMO asks for when an add-on is built from sources it
// cannot read directly (bundled, minified). Reviewers rebuild from it and
// compare against the uploaded zip, so it holds exactly what the build
// needs and a BUILD.md with the exact steps: the library sources at the
// repo root (the extension links `xmpp-httpx` from `../..`) and the
// extension directory. Run: npm run source-archive  (also part of `package`)
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(EXAMPLE, "../..");
const { version } = JSON.parse(readFileSync(join(EXAMPLE, "package.json"), "utf8"));
const NAME = `httpx-browser-source-${version}`;
const STAGE = join(EXAMPLE, "dist/source", NAME);
const ARTIFACTS = join(EXAMPLE, "dist/artifacts");

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "examples/webext"), { recursive: true });
mkdirSync(ARTIFACTS, { recursive: true });

// The library: everything `npm ci && npm run build` at the root needs.
for (const entry of ["src", "types", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "LICENSE"]) {
  cpSync(join(REPO, entry), join(STAGE, entry), { recursive: true });
}
// The extension: its sources and build configuration, no node_modules, no dist.
for (const entry of [
  "src",
  "scripts",
  "public",
  "browser.html",
  "manifest.base.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "README.md",
]) {
  cpSync(join(EXAMPLE, entry), join(STAGE, "examples/webext", entry), { recursive: true });
}

const node = process.versions.node;
writeFileSync(
  join(STAGE, "BUILD.md"),
  `# Building the httpx browser extension from this archive

This archive holds the sources of the \`xmpp-httpx\` library (repository
root) and of the extension (\`examples/webext/\`). The extension links the
library from \`../..\`, so both are built, in this order. No network access
is needed beyond \`npm ci\`; the build is deterministic given the lockfiles.

Tested with Node.js ${node} and the npm bundled with it. Any Node 20.10 or
newer should do.

\`\`\`sh
npm ci
npm run build                      # tsc → dist/ (the library)
cd examples/webext
npm ci                             # installs vite, web-ext, DOMPurify; links ../..
npx vite build && node scripts/make-manifests.mjs
\`\`\`

The Firefox build is then \`examples/webext/dist/firefox/\`; the uploaded
zip is \`web-ext build --source-dir dist/firefox\` of exactly that
directory. Only Vite's bundling stands between these sources and the
uploaded files: \`src/*.ts\` compile to \`dist/app/assets/*.js\`, and
\`scripts/make-manifests.mjs\` writes the manifest from
\`manifest.base.json\` plus the Firefox-specific keys.

Source: https://github.com/ooguz/xmpp-httpx (AGPL-3.0-only).
`,
);

const tarball = join(ARTIFACTS, `${NAME}.tar.gz`);
const tar = spawnSync("tar", ["-czf", tarball, "-C", dirname(STAGE), NAME], { stdio: "inherit" });
if (tar.status !== 0) process.exit(tar.status ?? 1);
console.log(`source archive: dist/artifacts/${NAME}.tar.gz (${(readFileSync(tarball).length / 1024).toFixed(0)} KiB)`);
