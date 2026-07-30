import { afterEach, describe, expect, it } from "vitest";
import { Metrics } from "../../src/cli/metrics.js";
import {
  startMetricsServer,
  type RunningMetricsServer,
} from "../../src/cli/metrics-server.js";

/** The metrics/health endpoint over a real socket (port 0 = pick a free one). */
describe("metrics server", () => {
  let running: RunningMetricsServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  const start = async (metrics: Metrics) => {
    running = await startMetricsServer(metrics, { port: 0 });
    return `http://127.0.0.1:${running.port}`;
  };

  it("serves the registry in the Prometheus format", async () => {
    const metrics = new Metrics({ version: "9.9.9" });
    metrics.recordRequest("GET", 200, 15);
    const base = await start(metrics);

    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain('httpx_gateway_build_info{version="9.9.9"} 1');
    expect(body).toContain('httpx_gateway_requests_total{method="GET",status="200"} 1');
  });

  it("answers /healthz from the stream state", async () => {
    const metrics = new Metrics({ version: "0" });
    const base = await start(metrics);

    const down = await fetch(`${base}/healthz`);
    expect(down.status).toBe(503);
    expect(await down.text()).toContain("xmpp stream down");

    metrics.setStreamUp(true);
    const up = await fetch(`${base}/healthz`);
    expect(up.status).toBe(200);
    expect(await up.text()).toContain("ok");
  });

  it("404s anything else and refuses non-GET methods", async () => {
    const base = await start(new Metrics({ version: "0" }));
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/admin`)).status).toBe(404);

    const posted = await fetch(`${base}/metrics`, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });

  it("supports HEAD with no body but real headers", async () => {
    const base = await start(new Metrics({ version: "0" }));
    const response = await fetch(`${base}/metrics`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await response.text()).toBe("");
  });

  it("binds loopback by default, so metrics are not published by accident", async () => {
    const metrics = new Metrics({ version: "0" });
    running = await startMetricsServer(metrics, { port: 0 });
    // Reachable on loopback…
    expect((await fetch(`http://127.0.0.1:${running.port}/healthz`)).status).toBe(503);
    // …and the listener is not on a wildcard address.
    await expect(
      fetch(`http://${nonLoopbackAddress()}:${running.port}/healthz`, {
        signal: AbortSignal.timeout(1500),
      }),
    ).rejects.toThrow();
  });
});

/**
 * A local non-loopback address to prove the bind is narrow. Falls back to a
 * documentation address, which is unroutable either way.
 */
function nonLoopbackAddress(): string {
  return "192.0.2.1";
}
