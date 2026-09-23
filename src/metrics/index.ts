/**
 * `xmpp-httpx/metrics`: the gateway's Prometheus registry and its `/metrics` +
 * `/healthz` listener, for applications that run an `HttpxServer` of their own
 * (an exit, a bridge) and want the same observability without a client
 * library. Both modules depend on nothing but `node:http`; they lived under
 * `cli/` only because the gateway was their first user.
 */
export { DEFAULT_BUCKETS, Metrics, type MetricsOptions } from "../cli/metrics.js";
export {
  startMetricsServer,
  type MetricsServerOptions,
  type RunningMetricsServer,
} from "../cli/metrics-server.js";
