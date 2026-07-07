import type { Element } from "@xmpp/xml";
import type { XmppSession } from "../session.js";

/**
 * Extension point for future body-transport mechanisms (sipub — XEP-0137,
 * jingle — XEP-0166). A registered transport is consulted when a <data>
 * descriptor decodes as "unsupported" with a matching element name.
 *
 * v1 ships no registered transports; the built-in mechanisms (inline,
 * chunkedBase64, ibb) are wired directly for simplicity.
 */
export interface BodyTransport {
  /** The <data> child element name this transport handles, e.g. "sipub". */
  readonly kind: string;
  /** Opens the receiving side for a decoded descriptor element. */
  receive(
    session: XmppSession,
    peer: string,
    descriptor: Element,
  ): Promise<ReadableStream<Uint8Array>>;
}

export class TransportRegistry {
  #transports = new Map<string, BodyTransport>();

  register(transport: BodyTransport): void {
    this.#transports.set(transport.kind, transport);
  }

  get(kind: string): BodyTransport | undefined {
    return this.#transports.get(kind);
  }
}
