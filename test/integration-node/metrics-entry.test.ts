import { describe, expect, it } from "vitest";
import { DEFAULT_BUCKETS, Metrics, startMetricsServer } from "../../src/metrics/index.js";

/**
 * The `xmpp-httpx/metrics` entry point exists for applications outside this
 * package (an exit, a bridge). What it re-exports is tested where it lives
 * (cli-observability, metrics-server); this pins the entry's surface so a
 * rename under cli/ cannot silently break a dependant.
 */
describe("xmpp-httpx/metrics entry point", () => {
  it("exposes the registry, its default buckets and the listener", () => {
    expect(typeof Metrics).toBe("function");
    expect(typeof startMetricsServer).toBe("function");
    expect(DEFAULT_BUCKETS.length).toBeGreaterThan(0);
  });

  it("renders a registry made through the entry", () => {
    const metrics = new Metrics({ version: "test" });
    metrics.recordRequest("GET", 200, 12);
    expect(metrics.render()).toContain("test");
  });
});
