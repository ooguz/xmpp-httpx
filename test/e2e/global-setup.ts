import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const composeFile = join(dirname(fileURLToPath(import.meta.url)), "docker-compose.yml");

async function compose(...args: string[]): Promise<string> {
  const { stdout } = await exec("docker", ["compose", "-f", composeFile, ...args], {
    timeout: 150_000,
  });
  return stdout;
}

async function registerUser(user: string, password: string): Promise<void> {
  try {
    await compose("exec", "-T", "prosody", "prosodyctl", "register", user, "localhost", password);
  } catch (err) {
    // "User exists" on re-runs against a kept container is fine.
    const message = err instanceof Error ? err.message : String(err);
    if (!/exists/i.test(message)) throw err;
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  console.log("[e2e] starting Prosody container…");
  await compose("up", "-d", "--wait");
  await registerUser("alice", "e2e-alice");
  await registerUser("bob", "e2e-bob");
  console.log("[e2e] Prosody ready");

  return async () => {
    if (process.env["E2E_KEEP"] === "1") {
      console.log("[e2e] E2E_KEEP=1 — leaving Prosody running");
      return;
    }
    await compose("down", "-v");
  };
}
