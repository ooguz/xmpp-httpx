import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { client, type XmppEntity } from "@xmpp/client";
import { httpxFetch, type XmppSession } from "xmpp-httpx";
import { configPath, createKeyFileAuth, loadConfig, saveConfig, type DpiConfig } from "./config.js";
import { DpiSetupError, serveConnection } from "./serve.js";
import { handleLocal, isLocalUrl, type PluginState } from "./settings.js";

/**
 * The plugin process — a *server* dpi in Dillo's terms.
 *
 * dpid starts it on the first `httpx://` request with a listening TCP socket
 * (127.0.0.1, some port) already bound as **stdin**, and connects to that
 * socket once per request from then on. Being a server rather than a
 * `.filter.dpi` is the whole point: one XMPP session stays signed in across
 * page loads, so the second page costs one IQ round-trip rather than a
 * connection, SASL and resource binding. dpid tells it to exit with `DpiBye`
 * (on `dpidc stop`, `dpidc register`, or Dillo's own exit).
 *
 * `HTTPX_DPI_LISTEN=host:port` listens there instead of on fd 0 — for the
 * smoke script and for running the plugin by hand outside dpid.
 *
 * `dpi:/httpx/` (Dillo's own URL form for a plugin's pages) is served here
 * too: a status page and a settings form, see settings.ts.
 */

const log = (line: string): void => {
  process.stderr.write(`[httpx.dpi] ${line}\n`);
};

const home = process.env.HOME ?? homedir();
const keyFile = join(home, ".dillo", "dpid_comm_keys");
const configFile = configPath(process.env, home);

let entity: XmppEntity | null = null;
let session: XmppSession | null = null;
let config: DpiConfig | null = null;
let connecting: Promise<XmppSession> | null = null;

async function ensureSession(status: (message: string) => void): Promise<XmppSession> {
  if (session !== null) return session;
  if (connecting === null) {
    connecting = (async () => {
      const next = await loadConfig(configFile);
      status(`httpx: signing in as ${next.jid}…`);
      const [username = "", domain = ""] = next.jid.split("@", 2);
      const xmpp = client({
        domain,
        username,
        password: next.password,
        resource: next.resource,
        ...(next.service !== undefined ? { service: next.service } : {}),
      });
      xmpp.on("error", (err: unknown) => {
        log(`stream error: ${err instanceof Error ? err.message : String(err)}`);
      });
      // A dropped connection is xmpp.js's to mend (its reconnect plugin retries
      // on its own); requests in the gap fail into error pages. "offline" is
      // only ever the result of our own stop().
      xmpp.on("disconnect", () => log("disconnected — xmpp.js is reconnecting"));
      xmpp.on("online", () => log("online"));
      xmpp.on("offline", () => {
        log("offline — will sign in again on the next request");
        session = null;
        entity = null;
      });
      try {
        await xmpp.start();
      } catch (err) {
        await xmpp.stop().catch(() => undefined);
        const reason = err instanceof Error ? err.message : String(err);
        throw new DpiSetupError(
          `Could not sign in as ${next.jid}: ${reason}`,
          `Check the password and service in ${configFile}, then reload.`,
        );
      }
      log(`signed in as ${xmpp.jid?.toString() ?? next.jid}`);
      entity = xmpp;
      config = next;
      session = xmpp as unknown as XmppSession;
      return session;
    })().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

/** Forget the live session; the next request signs in with the current file. */
async function dropSession(): Promise<void> {
  const old = entity;
  entity = null;
  session = null;
  config = null;
  if (old !== null) await old.stop().catch(() => undefined);
}

async function pluginState(): Promise<PluginState> {
  const state: PluginState = {
    signedInAs: entity?.jid?.toString() ?? null,
    configPath: configFile,
    config: null,
    configError: null,
  };
  try {
    state.config = await loadConfig(configFile);
  } catch (err) {
    state.configError = err instanceof Error ? err.message : String(err);
  }
  return state;
}

const server: Server = createServer((socket) => {
  void serveConnection(socket, {
    checkAuth: createKeyFileAuth(keyFile),
    fetch: async (url, context) => {
      if (isLocalUrl(url)) {
        return handleLocal(url, {
          state: pluginState,
          save: async (next) => {
            await saveConfig(configFile, next);
            await dropSession();
          },
          reconnect: dropSession,
        });
      }
      const live = await ensureSession(context.status);
      return httpxFetch(url, { session: live, timeoutMs: config?.timeoutMs ?? 30_000 });
    },
    onBye: () => void shutdown(0),
    log,
  });
});

let exiting = false;
async function shutdown(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  server.close();
  // Give dpid's DpiBye connection a moment to close cleanly, then leave
  // whatever the stream is doing.
  const stop = entity?.stop().catch(() => undefined) ?? Promise.resolve();
  await Promise.race([stop, new Promise((r) => setTimeout(r, 2000))]);
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
server.on("error", (err) => {
  log(`server error: ${err.message}`);
  void shutdown(1);
});

const listen = process.env.HTTPX_DPI_LISTEN;
if (listen !== undefined) {
  const colon = listen.lastIndexOf(":");
  const host = colon === -1 ? "127.0.0.1" : listen.slice(0, colon);
  const port = Number(colon === -1 ? listen : listen.slice(colon + 1));
  server.listen(port, host, () => {
    const address = server.address();
    const where = typeof address === "object" && address !== null ? `${address.address}:${address.port}` : listen;
    log(`listening on ${where} (HTTPX_DPI_LISTEN)`);
  });
} else {
  // dpid dup2()'d the listening socket onto fd 0 before exec (dpid/main.c).
  server.listen({ fd: 0 }, () => {
    log("serving on the socket dpid handed over");
  });
}
