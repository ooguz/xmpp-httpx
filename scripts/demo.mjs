// One command from a clean checkout to a browsable httpx site:
//
//   npm run demo          bring Prosody up, register the demo users, serve the
//                         demo site, and print what to do next
//   npm run demo -- --down    stop the container again
//
// Everything it does is what the README's step list says by hand; this exists
// because five copy-pasted commands is the difference between someone trying
// this project and not.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = ["compose", "-f", join(ROOT, "test/e2e/docker-compose.yml")];
const USERS = [
  ["alice", "e2e-alice"],
  ["bob", "e2e-bob"],
];

/** Runs a command to completion, inheriting stdio for anything interesting. */
function run(command, args, { quiet = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let captured = "";
    child.stdout?.on("data", (chunk) => (captured += chunk));
    child.stderr?.on("data", (chunk) => (captured += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || allowFailure) resolve({ code, output: captured });
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${captured}`));
    });
  });
}

const step = (message) => console.log(`\n▸ ${message}`);

if (process.argv.includes("--down")) {
  step("stopping the demo Prosody");
  await run("docker", [...COMPOSE, "down"]);
  console.log("\nDone. Nothing of the demo is left running.");
  process.exit(0);
}

try {
  await run("docker", ["--version"], { quiet: true });
} catch {
  console.error(
    "This demo needs Docker (it runs a throwaway Prosody).\n" +
      "Without it, point the gateway at any XMPP server you already have — see docs/gateway-cli.md.",
  );
  process.exit(1);
}

if (!existsSync(join(ROOT, "dist/index.js"))) {
  step("building the library (dist/ is missing)");
  await run("npm", ["run", "build"]);
}

step("starting Prosody (test/e2e/docker-compose.yml)");
await run("docker", [...COMPOSE, "up", "-d", "--wait"]);

step("registering the demo users");
for (const [user, password] of USERS) {
  // Already-registered is the normal case on a second run, not an error.
  const { code } = await run(
    "docker",
    [...COMPOSE, "exec", "-T", "prosody", "prosodyctl", "register", user, "localhost", password],
    { quiet: true, allowFailure: true },
  );
  console.log(`  ${user}@localhost ${code === 0 ? "registered" : "already existed"}`);
}

console.log(`
▸ Serving the demo site as httpx://web@httpx.localhost/

  Browse it with the WebExtension (examples/webext):
    npm --prefix examples/webext run build
    then load examples/webext/dist/firefox (about:debugging) or
    dist/chromium (chrome://extensions, Load unpacked)

  In its connection settings:
    service   ws://localhost:15280/xmpp-websocket
    JID       alice@localhost
    password  e2e-alice

  Or drive the whole thing headlessly:  npm run smoke
  Stop the container when you are done: npm run demo -- --down

Gateway log follows; Ctrl-C to stop it (Prosody keeps running).
`);

const gateway = spawn(process.execPath, [join(ROOT, "scripts/demo-gateway.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});

const stop = () => {
  gateway.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
gateway.on("exit", (code) => {
  console.log("\nGateway stopped. Prosody is still up — `npm run demo -- --down` to stop it.");
  process.exit(code ?? 0);
});
