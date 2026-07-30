import xml, { Element } from "@xmpp/xml";
import parse from "@xmpp/xml/lib/parse.js";
import { NS_STANZAS } from "../constants.js";
import type { IqContext, IqHandler, XmppSession } from "../session.js";

/**
 * A test double for `XmppSession`, published as `xmpp-httpx/testing` so
 * downstream users can exercise their own handlers and clients without an XMPP
 * server. It is the very harness this library's own integration suite runs on,
 * which is the point: if it drifted from real semantics, those tests would fail.
 *
 * In-memory XmppSession pair mirroring @xmpp/client's iqCaller/iqCallee
 * semantics: async handlers, error elements → IQ errors, thrown handlers →
 * internal-server-error, no matching handler → service-unavailable.
 * Delivery is asynchronous (microtask) and in order, like a real stream.
 *
 * `deliverHook` intercepts outbound stanzas for fault injection: call
 * deliver() to pass the stanza on (possibly later / reordered), or drop it.
 */

class MockStanzaError extends Error {
  readonly condition: string;
  constructor(condition: string) {
    super(condition);
    this.name = "StanzaError";
    this.condition = condition;
  }
}

class MockTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

interface Route {
  type: "get" | "set";
  ns: string;
  name: string;
  handler: IqHandler;
}

interface PendingIq {
  resolve: (stanza: Element) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type DeliverHook = (stanza: Element, deliver: () => void) => void;

let idCounter = 0;

export class MockSession implements XmppSession {
  readonly jid: { toString(): string };
  peer!: MockSession;
  deliverHook: DeliverHook | undefined;

  readonly #routes: Route[] = [];
  readonly #pending = new Map<string, PendingIq>();
  readonly #listeners = new Set<(stanza: Element) => void>();

  constructor(jid: string) {
    this.jid = { toString: () => jid };
  }

  async send(stanza: Element): Promise<void> {
    // Serialize + reparse: exactly what the wire would do, and it decouples
    // the delivered element tree from the sender's.
    const outbound = parse(stanza.toString());
    if (!outbound.attrs["from"]) outbound.attrs["from"] = this.jid.toString();
    const deliver = () => this.peer.receive(outbound);
    if (this.deliverHook) {
      this.deliverHook(outbound, deliver);
    } else {
      queueMicrotask(deliver);
    }
  }

  readonly iqCaller = {
    request: (iq: Element, timeoutMs = 30_000): Promise<Element> => {
      if (!iq.attrs["id"]) iq.attrs["id"] = `mock-${++idCounter}`;
      const id = iq.attrs["id"];
      return new Promise<Element>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new MockTimeoutError());
        }, timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        void this.send(iq);
      });
    },
  };

  readonly iqCallee = {
    get: (ns: string, name: string, handler: IqHandler): void => {
      this.#routes.push({ type: "get", ns, name, handler });
    },
    set: (ns: string, name: string, handler: IqHandler): void => {
      this.#routes.push({ type: "set", ns, name, handler });
    },
  };

  on(event: "stanza", listener: (stanza: Element) => void): this {
    if (event === "stanza") this.#listeners.add(listener);
    return this;
  }

  removeListener(event: "stanza", listener: (stanza: Element) => void): this {
    if (event === "stanza") this.#listeners.delete(listener);
    return this;
  }

  receive(stanza: Element): void {
    for (const listener of [...this.#listeners]) listener(stanza);

    if (stanza.getName() !== "iq") return;
    const type = stanza.attrs["type"];
    const id = stanza.attrs["id"] ?? "";

    if (type === "result" || type === "error") {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (type === "error") {
        const errorEl = stanza.getChild("error");
        const condition =
          errorEl
            ?.getChildElements()
            .find((c) => c.getNS() === NS_STANZAS)
            ?.getName() ?? "undefined-condition";
        pending.reject(new MockStanzaError(condition));
      } else {
        pending.resolve(stanza);
      }
      return;
    }

    if (type === "get" || type === "set") {
      void this.#handleIq(stanza, type);
    }
  }

  async #handleIq(stanza: Element, type: "get" | "set"): Promise<void> {
    const reply = (
      replyType: "result" | "error",
      ...children: Element[]
    ): Element =>
      xml(
        "iq",
        {
          type: replyType,
          to: stanza.attrs["from"] ?? "",
          from: stanza.attrs["to"] ?? this.jid.toString(),
          id: stanza.attrs["id"] ?? "",
        },
        ...children,
      );

    const errorReply = (errType: string, condition: string): Element =>
      reply(
        "error",
        xml("error", { type: errType }, xml(condition, { xmlns: NS_STANZAS })),
      );

    const children = stanza.getChildElements();
    const child = children[0];
    if (!child || children.length !== 1) {
      await this.send(errorReply("modify", "bad-request"));
      return;
    }

    const route = this.#routes.find(
      (r) => r.type === type && child.is(r.name, r.ns),
    );
    if (!route) {
      await this.send(errorReply("cancel", "service-unavailable"));
      return;
    }

    const ctx: IqContext = {
      stanza,
      element: child,
      from: stanza.attrs["from"]
        ? { toString: () => stanza.attrs["from"]! }
        : null,
      to: stanza.attrs["to"] ? { toString: () => stanza.attrs["to"]! } : null,
      type,
      id: stanza.attrs["id"] ?? "",
    };

    let result: Element | boolean;
    try {
      result = await route.handler(ctx);
    } catch {
      await this.send(errorReply("cancel", "internal-server-error"));
      return;
    }

    if (result instanceof Element && result.is("error")) {
      await this.send(reply("error", result));
    } else if (result instanceof Element) {
      await this.send(reply("result", result));
    } else {
      await this.send(reply("result"));
    }
  }
}

export function createSessionPair(
  jidA = "client@example.org/browser",
  jidB = "server@example.org",
): [MockSession, MockSession] {
  const a = new MockSession(jidA);
  const b = new MockSession(jidB);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
