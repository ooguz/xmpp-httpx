import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DpiSetupError } from "./serve.js";

/**
 * `~/.dillo/httpx.json` — the account the plugin browses with. Plaintext,
 * like Dillo's own `cookiesrc` next to it; the README says so rather than
 * pretending otherwise. Re-read on every (re)connect, so editing it needs no
 * plugin restart.
 */
export interface DpiConfig {
  /** Bare JID, `alice@example.org`. */
  jid: string;
  password: string;
  /** `wss://…` / `xmpp://…`; omitted → resolved from the JID's domain. */
  service: string | undefined;
  resource: string;
  /** Per-request IQ timeout. */
  timeoutMs: number;
}

export const CONFIG_ENV = "HTTPX_DPI_CONFIG";

export function configPath(env: Record<string, string | undefined>, home: string): string {
  return env[CONFIG_ENV] ?? join(home, ".dillo", "httpx.json");
}

const HINT = `Create it with your account, e.g.
{ "jid": "alice@example.org", "password": "…", "service": "wss://example.org/xmpp-websocket" }
— see examples/dillo/README.md in xmpp-httpx.`;

export async function loadConfig(path: string): Promise<DpiConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DpiSetupError(`Cannot read ${path}: ${reason}`, HINT);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DpiSetupError(`${path} is not valid JSON: ${reason}`, HINT);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DpiSetupError(`${path} must hold a JSON object`, HINT);
  }
  const object = raw as Record<string, unknown>;

  const jid = object.jid;
  if (typeof jid !== "string" || !/^[^@/\s]+@[^@/\s]+$/.test(jid)) {
    throw new DpiSetupError(`${path}: "jid" must be a bare JID like alice@example.org`, HINT);
  }
  const password = object.password;
  if (typeof password !== "string" || password === "") {
    throw new DpiSetupError(`${path}: "password" is required`, HINT);
  }
  const service = object.service;
  if (service !== undefined && typeof service !== "string") {
    throw new DpiSetupError(`${path}: "service" must be a string URL when present`, HINT);
  }
  const resource = object.resource ?? "dillo";
  if (typeof resource !== "string" || resource === "") {
    throw new DpiSetupError(`${path}: "resource" must be a non-empty string`, HINT);
  }
  const timeoutMs = object.timeoutMs ?? 30_000;
  if (typeof timeoutMs !== "number" || !(timeoutMs > 0)) {
    throw new DpiSetupError(`${path}: "timeoutMs" must be a positive number`, HINT);
  }

  return { jid, password, service, resource, timeoutMs };
}

/**
 * Dillo's shared secret, as `a_Dpip_check_auth` reads it: the first line of
 * `~/.dillo/dpid_comm_keys` is `<dpid port> <hex key>`. Read on every check —
 * the key changes whenever dpid restarts, and this process may outlive one.
 */
export function createKeyFileAuth(path: string): (message: string) => Promise<boolean> {
  return async (message) => {
    let line: string;
    try {
      line = (await readFile(path, "utf8")).split("\n", 1)[0] ?? "";
    } catch {
      return false;
    }
    const match = /^\s*[+-]?\d+.([0-9A-Fa-f]*)/.exec(line);
    const key = match?.[1] ?? "";
    return key !== "" && constantTimeEqual(key, message);
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
