import { JingleTransport } from "../jingle/jingle.js";
import type { XmppSession } from "../session.js";
import { SipubTransport } from "../sipub/sipub.js";
import { TransportRegistry } from "./registry.js";

/** The registry HttpxClient/HttpxServer construct: sipub + jingle. */
export function createDefaultRegistry(session: XmppSession): TransportRegistry {
  const registry = new TransportRegistry();
  registry.register(new SipubTransport(session));
  registry.register(new JingleTransport(session));
  return registry;
}
