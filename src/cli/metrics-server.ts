import { createServer, type Server } from "node:http";
import type { Metrics } from "./metrics.js";

/**
 * The gateway's only listening socket: `/metrics` for Prometheus and `/healthz`
 * for liveness probes.
 *
 * It defaults to **127.0.0.1** because these endpoints expose who is using the
 * gateway (denied-JID labels) and should not be published by accident; binding
 * wider is a deliberate `--metrics-address 0.0.0.0` away, which is what a
 * container needs.
 */

export interface MetricsServerOptions {
  port: number;
  address?: string;
}

export interface RunningMetricsServer {
  /** Actual bound port, useful when 0 was requested (tests). */
  port: number;
  close(): Promise<void>;
}

const PROMETHEUS_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export async function startMetricsServer(
  metrics: Metrics,
  options: MetricsServerOptions,
): Promise<RunningMetricsServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    if (path === "/metrics") {
      const body = metrics.render();
      res.writeHead(200, {
        "content-type": PROMETHEUS_TYPE,
        "content-length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (path === "/healthz") {
      // Healthy means "the XMPP stream is up", the only liveness fact the
      // gateway has: it serves no port of its own for requests.
      const healthy = metrics.healthy;
      const body = healthy ? "ok\n" : "xmpp stream down\n";
      res.writeHead(healthy ? 200 : 503, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : "not found\n");
  });

  const address = options.address ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const bound = server.address();
  return {
    port: typeof bound === "object" && bound !== null ? bound.port : options.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
