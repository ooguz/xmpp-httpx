import { JingleTransport } from "../jingle/jingle.js";
import type { XmppSession } from "../session.js";
import { SipubTransport } from "../sipub/sipub.js";
import type { Socks5Adapter } from "../socks5/protocol.js";
import { TransportRegistry } from "./registry.js";

/** The registry HttpxClient/HttpxServer construct: sipub + jingle. `socks5`,
 * if given, lets sipub offer XEP-0065 (as an SI stream method) and jingle offer
 * XEP-0260 s5b candidates, both alongside IBB. See src/node/socks5.js for the
 * Node-only adapter; without it both transports stay on IBB. */
export function createDefaultRegistry(
  session: XmppSession,
  options?: { socks5?: Socks5Adapter },
): TransportRegistry {
  const registry = new TransportRegistry();
  registry.register(new SipubTransport(session, options?.socks5));
  registry.register(new JingleTransport(session, options?.socks5));
  return registry;
}
