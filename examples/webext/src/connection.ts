import { client, type XmppEntity } from "@xmpp/client";
import type { XmppSession } from "xmpp-httpx";
import type { ConnectionSettings } from "./settings.js";

export type ConnectionState = "disconnected" | "connecting" | "online";

/**
 * Owns the XMPP connection for this browser tab. Living in the page (not
 * the background service worker) sidesteps MV3 worker-lifetime issues: the
 * connection exists exactly while the user is browsing httpx content.
 */
export class Connection {
  #entity: XmppEntity | undefined;
  #state: ConnectionState = "disconnected";
  onStateChange: ((state: ConnectionState) => void) | undefined;

  get state(): ConnectionState {
    return this.#state;
  }

  get session(): XmppSession {
    if (!this.#entity || this.#state !== "online") {
      throw new Error("not connected — open settings and connect first");
    }
    return this.#entity as unknown as XmppSession;
  }

  async connect(settings: ConnectionSettings): Promise<void> {
    await this.disconnect();
    const at = settings.jid.indexOf("@");
    if (at <= 0) throw new Error(`not a user JID: ${settings.jid}`);
    const username = settings.jid.slice(0, at);
    const domain = settings.jid.slice(at + 1);

    this.#setState("connecting");
    const entity = client({
      service: settings.service,
      domain,
      username,
      password: settings.password,
      resource: `httpx-browser-${Math.random().toString(36).slice(2, 8)}`,
    });
    entity.on("error", (err: unknown) => {
      console.error("[httpx] xmpp error:", err);
    });
    entity.on("offline", () => this.#setState("disconnected"));
    entity.on("online", () => this.#setState("online"));

    this.#entity = entity;
    try {
      await entity.start();
    } catch (err) {
      this.#entity = undefined;
      this.#setState("disconnected");
      throw err;
    }
    this.#setState("online");
  }

  async disconnect(): Promise<void> {
    const entity = this.#entity;
    this.#entity = undefined;
    if (entity) {
      await entity.stop().catch(() => {});
    }
    this.#setState("disconnected");
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.onStateChange?.(state);
  }
}
