export {
  createOriginProxyHandler,
  type OriginProxyOptions,
} from "./origin-proxy.js";
export { createSocks5Adapter, type Socks5AdapterOptions } from "./socks5.js";
// Forward proxying: where to connect, and the handlers that do it.
export {
  DestinationPolicy,
  DestinationRefused,
  embeddedV4,
  type DestinationPolicyOptions,
  type Verdict as DestinationVerdict,
} from "./destination.js";
export {
  createForwardProxyHandler,
  forwardTarget,
  type ForwardProxyOptions,
  type ForwardTarget,
} from "./forward-proxy.js";
export {
  createConnectHandler,
  splitAuthority,
  type ConnectHandlerOptions,
} from "./connect-proxy.js";
export { bridgeTunnel, type BridgeTunnelOptions } from "./bridge.js";
export { stripHopByHop } from "./hop-by-hop.js";
