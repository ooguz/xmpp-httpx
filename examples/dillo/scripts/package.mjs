// Builds the distributable Dillo plugin: one bundled JS file plus a launcher
// and an installer, as a tarball under dist/artifacts/.
//
//   dist/pkg/httpx-dillo-dpi-<version>/
//     install.sh            copies everything into place, adds the dpidrc line
//     httpx.dpi             the launcher dpid execs; finds node at run time
//     lib/httpx.js          the plugin, bundled by esbuild (xmpp-httpx, @xmpp/*, ws…)
//     httpx.json.example    the demo account, to be replaced
//     README.md, LICENSE, LICENSES.txt
//
// LICENSES.txt is assembled from the packages esbuild actually pulled into the
// bundle (its metafile lists every input), so it stays true when a dependency
// changes. Run: npm run package
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(new URL(import.meta.url)));
const EXAMPLE = resolve(HERE, "..");
const REPO = resolve(EXAMPLE, "../..");
const { version } = JSON.parse(readFileSync(join(EXAMPLE, "package.json"), "utf8"));
const NAME = `httpx-dillo-dpi-${version}`;
const OUT = join(EXAMPLE, "dist/pkg", NAME);
const ARTIFACTS = join(EXAMPLE, "dist/artifacts");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "lib"), { recursive: true });
mkdirSync(ARTIFACTS, { recursive: true });

const result = await build({
  entryPoints: [join(EXAMPLE, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(OUT, "lib/httpx.js"),
  // ws's optional native accelerators; absent at run time they are simply not used.
  external: ["bufferutil", "utf-8-validate"],
  // CJS dependencies inside an ESM bundle need a require() to exist.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// --- third-party licenses, from what actually went into the bundle -------------
const packages = new Map(); // dir → {name, version, license}
for (const input of Object.keys(result.metafile.inputs)) {
  const abs = resolve(EXAMPLE, input);
  const marker = abs.lastIndexOf("/node_modules/");
  if (marker === -1) continue;
  // Walk up from the file to the nearest package.json under node_modules.
  let dir = dirname(abs);
  while (dir.length > marker && !existsSync(join(dir, "package.json"))) dir = dirname(dir);
  if (packages.has(dir)) continue;
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  // The same package can be installed twice (hoisted and nested); one entry.
  if ([...packages.values()].some((p) => p.name === pkg.name && p.version === pkg.version)) continue;
  if (pkg.name === "xmpp-httpx") continue; // ours; LICENSE ships separately
  // A nested package.json without a name (a "type" marker) belongs to the
  // package above it; skip it and let that package's own entry stand.
  if (typeof pkg.name !== "string") continue;
  const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  packages.set(dir, {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? "(not declared)",
    text: licenseFile ? readFileSync(join(dir, licenseFile), "utf8").trim() : null,
  });
}
const licenses = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
let licensesText = `Third-party packages bundled into lib/httpx.js (${licenses.length}):\n\n`;
for (const p of licenses) licensesText += `  ${p.name}@${p.version}  ${p.license}\n`;
licensesText += "\n";
for (const p of licenses) {
  licensesText += `${"=".repeat(72)}\n${p.name}@${p.version} (${p.license})\n${"=".repeat(72)}\n`;
  licensesText += `${p.text ?? "(no license file in the package; see its package.json)"}\n\n`;
}
writeFileSync(join(OUT, "LICENSES.txt"), licensesText);

// --- the rest of the package ----------------------------------------------------------
cpSync(join(EXAMPLE, "pkg/install.sh"), join(OUT, "install.sh"));
cpSync(join(EXAMPLE, "pkg/httpx.dpi"), join(OUT, "httpx.dpi"));
chmodSync(join(OUT, "install.sh"), 0o755);
chmodSync(join(OUT, "httpx.dpi"), 0o755);
cpSync(join(EXAMPLE, "pkg/README.md"), join(OUT, "README.md"));
cpSync(join(EXAMPLE, "httpx.json.example"), join(OUT, "httpx.json.example"));
cpSync(join(REPO, "LICENSE"), join(OUT, "LICENSE"));

const tarball = join(ARTIFACTS, `${NAME}.tar.gz`);
const tar = spawnSync("tar", ["-czf", tarball, "-C", dirname(OUT), NAME], { stdio: "inherit" });
if (tar.status !== 0) process.exit(tar.status ?? 1);

const size = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;
console.log(`bundle   ${relative(EXAMPLE, join(OUT, "lib/httpx.js"))}  ${size(readFileSync(join(OUT, "lib/httpx.js")).length)}`);
console.log(`licenses ${licenses.length} packages → LICENSES.txt`);
console.log(`tarball  ${relative(EXAMPLE, tarball)}  ${size(readFileSync(tarball).length)}`);
