import { client, type XmppEntity } from "@xmpp/client";
import { component } from "@xmpp/component";
import type { XmppSession } from "../../src/session.js";

export const WS_SERVICE = "ws://localhost:15280/xmpp-websocket";
export const COMPONENT_SERVICE = "xmpp://localhost:15347";
export const DOMAIN = "localhost";
export const COMPONENT_DOMAIN = "httpx.localhost";
export const COMPONENT_SECRET = "e2e-secret";

/** start() with retries — Prosody may still be settling right after --wait. */
async function startWithRetry(entity: XmppEntity, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await entity.start();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`[e2e] could not connect ${label}: ${String(lastError)}`);
}

export interface E2eClient {
  entity: XmppEntity;
  session: XmppSession;
  jid: string;
  stop(): Promise<void>;
}

export async function connectUser(
  username: string,
  password: string,
  resource: string,
): Promise<E2eClient> {
  const entity = client({
    service: WS_SERVICE,
    domain: DOMAIN,
    resource,
    username,
    password,
  });
  // Surface stream errors in test output instead of crashing the process.
  entity.on("error", (err: unknown) => {
    console.error(`[e2e] ${username} stream error:`, err);
  });
  await startWithRetry(entity, username);
  return {
    entity,
    session: entity as unknown as XmppSession,
    jid: entity.jid?.toString() ?? `${username}@${DOMAIN}/${resource}`,
    stop: () => entity.stop().then(() => undefined),
  };
}

export async function connectComponent(): Promise<E2eClient> {
  const entity = component({
    service: COMPONENT_SERVICE,
    domain: COMPONENT_DOMAIN,
    password: COMPONENT_SECRET,
  });
  entity.on("error", (err: unknown) => {
    console.error("[e2e] component stream error:", err);
  });
  await startWithRetry(entity, "component");
  return {
    entity,
    session: entity as unknown as XmppSession,
    jid: COMPONENT_DOMAIN,
    stop: () => entity.stop().then(() => undefined),
  };
}
