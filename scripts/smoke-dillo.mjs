// End-to-end smoke test of the Dillo plugin: the *packaged* plugin (the
// tarball `npm run package` builds) is installed by its own install.sh into a
// throwaway $HOME, a real dpid launches it, and this script speaks to both exactly
// the way Dillo does (src/IO/dpi.c) — check_server → the plugin's port → auth
// → open_url — against the demo gateway over real XMPP. Then, when `dillo`
// and `xvfb-run` exist, Dillo itself loads the page under Xvfb and a
// screenshot lands in examples/dillo/dist/smoke-dillo.png.
//
// The vitest suite (test/integration-node/dillo-dpi.test.ts) proves the
// framing over the mock pair; this proves the parts only dpid can: that the
// dpidrc line routes proto.httpx here, that the launcher execs under dpid's
// environment, and that fd 0 really is the listening socket.
//
// Prereqs:
//   npm run demo                       Prosody up, alice registered, library built
//   npm --prefix examples/dillo install && npm --prefix examples/dillo run package
// Run: npm run smoke:dillo
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLE = join(ROOT, "examples/dillo");
const PAGE = "httpx://web@httpx.localhost/";
const TIMEOUT = 20_000;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};
const which = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

const tarball = existsSync(join(EXAMPLE, "dist/artifacts"))
  ? readdirSync(join(EXAMPLE, "dist/artifacts"))
      .filter((f) => /^httpx-dillo-dpi-.*\.tar\.gz$/.test(f))
      .sort()
      .at(-1)
  : undefined;
if (tarball === undefined) {
  console.error("package the plugin first: npm --prefix examples/dillo install && npm --prefix examples/dillo run package");
  process.exit(2);
}
if (!which("dpid")) {
  console.error("dpid is not on PATH — install Dillo");
  process.exit(2);
}

// --- a throwaway home ------------------------------------------------------------
const HOME = mkdtempSync(join(tmpdir(), "httpx-dillo-"));
const env = { ...process.env, HOME };
mkdirSync(join(HOME, ".dillo"), { recursive: true });
// Dillo itself reads dillorc from here too; an empty one keeps its defaults.
writeFileSync(join(HOME, ".dillo/dillorc"), "");

// Unpack the tarball somewhere that is not the checkout and install from there,
// the way a user would.
const unpacked = mkdtempSync(join(tmpdir(), "httpx-dillo-pkg-"));
const untar = spawnSync("tar", ["-xzf", join(EXAMPLE, "dist/artifacts", tarball), "-C", unpacked], { encoding: "utf8" });
check(`unpacked ${tarball}`, untar.status === 0, untar.stderr);
const pkgDir = join(unpacked, readdirSync(unpacked)[0] ?? "");
const install = spawnSync("sh", [join(pkgDir, "install.sh")], { env, encoding: "utf8" });
check("install.sh wrote the launcher, the bundle and dpidrc", install.status === 0, install.stderr);
check("bundle landed under the throwaway $HOME", existsSync(join(HOME, ".local/share/httpx-dpi/httpx.js")));
check("launcher is not tied to the checkout", !readFileSync(join(HOME, ".dillo/dpi/httpx/httpx.dpi"), "utf8").includes(ROOT));
writeFileSync(
  join(HOME, ".dillo/httpx.json"),
  JSON.stringify(
    {
      jid: "alice@localhost",
      password: "e2e-alice",
      service: "ws://localhost:15280/xmpp-websocket",
      resource: "dillo-smoke",
    },
    null,
    2,
  ),
);
const dpidrc = readFileSync(join(HOME, ".dillo/dpidrc"), "utf8");
check("dpidrc routes proto.httpx", /^proto\.httpx=httpx\/httpx\.dpi$/m.test(dpidrc));

// --- demo gateway + dpid -------------------------------------------------------------
const children = [];
const gateway = spawn(process.execPath, [join(ROOT, "scripts/demo-gateway.mjs")], {
  stdio: ["ignore", "pipe", "inherit"],
});
children.push(gateway);
try {
  await waitFor(gateway.stdout, /\[gateway\] serving/, "demo gateway");
} catch (err) {
  check("demo gateway started (is the E2E Prosody up? `npm run demo`)", false, String(err));
  for (const child of children) child.kill();
  process.exit(1);
}

const dpid = spawn("dpid", [], { env, stdio: ["ignore", "pipe", "pipe"] });
children.push(dpid);
let pluginLog = "";
dpid.stderr.on("data", (chunk) => {
  pluginLog += chunk.toString();
  for (const line of chunk.toString().split("\n")) if (line.trim()) console.log(`  ${line}`);
});
dpid.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) if (line.trim()) console.log(`  ${line}`);
});
const keysFile = join(HOME, ".dillo/dpid_comm_keys");
const deadline = Date.now() + TIMEOUT;
while (!existsSync(keysFile) && Date.now() < deadline) await sleep(100);
check("dpid wrote dpid_comm_keys", existsSync(keysFile));
const [dpidPort, secret] = readFileSync(keysFile, "utf8").trim().split(" ");

// --- talk like Dillo ----------------------------------------------------------------
async function openUrl(url, server = "proto.httpx") {
  // 1. ask dpid where the plugin is (starting it if need be). Dillo asks for
  //    "proto.httpx" for httpx:// URLs and for "httpx" for dpi:/httpx/ ones.
  const reply = await exchange(Number(dpidPort), [
    `<cmd='auth' msg='${secret}' '>`,
    `<cmd='check_server' msg='${server}' '>`,
  ]);
  const port = /<cmd='send_data' msg='(\d+)' '>/.exec(reply.text)?.[1];
  if (!port) throw new Error(`dpid did not hand over a port: ${reply.text}`);
  // 2. the request itself
  const got = await exchange(Number(port), [`<cmd='auth' msg='${secret}' '>`, `<cmd='open_url' url='${url}' '>`]);
  // Status-bar tags may precede the page (`send_status_message` while the
  // plugin signs in); the page starts at `start_send_page`.
  let raw = got.bytes;
  let tag;
  for (;;) {
    const tagEnd = raw.indexOf(" '>");
    if (tagEnd === -1) throw new Error(`no dpip tag in the reply: ${raw.subarray(0, 200)}`);
    tag = raw.subarray(0, tagEnd + 3).toString();
    raw = raw.subarray(tagEnd + 3);
    if (!tag.startsWith("<cmd='send_status_message'")) break;
  }
  const payload = raw;
  const headEnd = payload.indexOf("\r\n\r\n");
  return {
    tag,
    head: payload.subarray(0, headEnd).toString(),
    body: payload.subarray(headEnd + 4),
  };
}

try {
  const home = await openUrl(PAGE);
  check("start_send_page tag", home.tag === `<cmd='start_send_page' url='${PAGE}' '>`, home.tag);
  check("200 for the demo page", home.head.startsWith("HTTP/1.1 200 OK"), home.head.split("\r\n")[0]);
  check("text/html", /^content-type: text\/html/m.test(home.head), home.head);
  check("page body arrived", home.body.toString().includes("Hello from XEP-0332"));

  const logo = await openUrl(`${PAGE}img/logo.png`);
  check("image/png for the logo", /^content-type: image\/png/m.test(logo.head), logo.head);
  check("PNG signature", logo.body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

  const missing = await openUrl(`${PAGE}nope`);
  check("404 passes through", missing.head.startsWith("HTTP/1.1 404"), missing.head.split("\r\n")[0]);

  check("plugin signed in once", (pluginLog.match(/signed in as alice@localhost/g) ?? []).length === 1);

  const settings = await openUrl("dpi:/httpx/", "httpx");
  check("dpi:/httpx/ status page", settings.head.startsWith("HTTP/1.1 200 OK"), settings.head.split("\r\n")[0]);
  check("status page shows the signed-in JID", settings.body.toString().includes("Signed in as <b>alice@localhost/dillo-smoke</b>"));
  check("same plugin process served both names", (pluginLog.match(/serving on the socket/g) ?? []).length === 1);

  // --- Dillo itself, if it can run headless here -----------------------------------
  if (which("dillo") && which("xvfb-run")) {
    const shot = join(EXAMPLE, "dist/smoke-dillo.png");
    rmSync(shot, { force: true });
    const before = pluginLog.length;
    const capture = which("import") ? `import -window root "${shot}"` : `xwd -root -silent | convert xwd:- "${shot}"`;
    // Asynchronous, so the plugin's log lines keep arriving while Dillo runs.
    const run = await runToEnd(
      "xvfb-run",
      ["-a", "-s", "-screen 0 1024x768x24", "sh", "-c", `dillo -f "${PAGE}" & p=$!; sleep 8; ${capture}; kill $p`],
      env,
    );
    await sleep(300);
    const since = pluginLog.slice(before);
    check("Dillo ran under Xvfb", run.status === 0, run.stderr);
    check("Dillo loaded the page through the plugin", since.includes(`${PAGE} → 200`), since);
    check("Dillo fetched the page's image through the plugin", since.includes(`${PAGE}img/logo.png → 200`), since);
    check("screenshot written", existsSync(shot), shot);
    if (existsSync(shot)) console.log(`     ${shot}`);
  } else {
    console.log("skip Dillo under Xvfb (dillo or xvfb-run not installed)");
  }
} catch (err) {
  check("smoke run", false, err instanceof Error ? err.message : String(err));
} finally {
  // dpidc stop → dpid sends DpiBye to the plugin and exits.
  spawnSync("dpidc", ["stop"], { env });
  await sleep(500);
  for (const child of children) child.kill();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(unpacked, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

// --- helpers ----------------------------------------------------------------------
function exchange(port, tags) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from 127.0.0.1:${port} within ${TIMEOUT}ms`));
    }, TIMEOUT);
    socket.on("connect", () => {
      for (const tag of tags) socket.write(tag);
    });
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      resolve({ bytes, text: bytes.toString() });
    });
  });
}

function runToEnd(command, args, childEnv) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: childEnv, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

function waitFor(stream, pattern, what) {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`${what} did not start: ${seen}`)), TIMEOUT);
    stream.on("data", (chunk) => {
      seen += chunk.toString();
      if (pattern.test(seen)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
