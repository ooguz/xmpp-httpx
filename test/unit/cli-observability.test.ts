import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/cli/logger.js";
import { Metrics } from "../../src/cli/metrics.js";

/** Collects the lines a logger writes. */
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, opts: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const AT = () => new Date("2026-07-30T12:00:00.000Z");

describe("Metrics — Prometheus text format", () => {
  it("renders build info and stream state", () => {
    const metrics = new Metrics({ version: "1.2.3" });
    const text = metrics.render();
    expect(text).toContain('httpx_gateway_build_info{version="1.2.3"} 1');
    expect(text).toContain("httpx_gateway_stream_up 0");
    expect(metrics.healthy).toBe(false);

    metrics.setStreamUp(true);
    expect(metrics.render()).toContain("httpx_gateway_stream_up 1");
    expect(metrics.healthy).toBe(true);
  });

  it("counts requests per method and status", () => {
    const metrics = new Metrics({ version: "0" });
    metrics.recordRequest("GET", 200, 10);
    metrics.recordRequest("GET", 200, 20);
    metrics.recordRequest("GET", 404, 5);
    metrics.recordRequest("POST", 200, 30);
    const text = metrics.render();
    expect(text).toContain('httpx_gateway_requests_total{method="GET",status="200"} 2');
    expect(text).toContain('httpx_gateway_requests_total{method="GET",status="404"} 1');
    expect(text).toContain('httpx_gateway_requests_total{method="POST",status="200"} 1');
  });

  it("builds a cumulative histogram with sum and count", () => {
    const metrics = new Metrics({ version: "0", buckets: [0.01, 0.1, 1] });
    metrics.recordRequest("GET", 200, 5); // 0.005s
    metrics.recordRequest("GET", 200, 50); // 0.05s
    metrics.recordRequest("GET", 200, 5000); // 5s — over every bucket
    const text = metrics.render();
    expect(text).toContain('httpx_gateway_request_duration_seconds_bucket{le="0.01"} 1');
    expect(text).toContain('httpx_gateway_request_duration_seconds_bucket{le="0.1"} 2');
    expect(text).toContain('httpx_gateway_request_duration_seconds_bucket{le="1"} 2');
    expect(text).toContain('httpx_gateway_request_duration_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain("httpx_gateway_request_duration_seconds_count 3");
    expect(text).toContain("httpx_gateway_request_duration_seconds_sum 5.055");
  });

  it("labels denials by bare JID only, to bound cardinality", () => {
    const metrics = new Metrics({ version: "0" });
    metrics.recordDenied("eve@example.org/laptop");
    metrics.recordDenied("eve@example.org/phone");
    const text = metrics.render();
    expect(text).toContain(
      'httpx_gateway_requests_denied_total{jid="eve@example.org"} 2',
    );
    expect(text).not.toContain("laptop");
  });

  it("counts errors by kind", () => {
    const metrics = new Metrics({ version: "0" });
    metrics.recordError("origin");
    metrics.recordError("origin");
    metrics.recordError("stream");
    const text = metrics.render();
    expect(text).toContain('httpx_gateway_errors_total{kind="origin"} 2');
    expect(text).toContain('httpx_gateway_errors_total{kind="stream"} 1');
  });

  it("escapes label values that would break the format", () => {
    const metrics = new Metrics({ version: 'we"ird\\' });
    expect(metrics.render()).toContain('version="we\\"ird\\\\"');
  });

  it("emits HELP and TYPE for every metric, and ends with a newline", () => {
    const metrics = new Metrics({ version: "0" });
    const text = metrics.render();
    for (const name of [
      "httpx_gateway_build_info",
      "httpx_gateway_stream_up",
      "httpx_gateway_requests_total",
      "httpx_gateway_requests_denied_total",
      "httpx_gateway_errors_total",
      "httpx_gateway_request_duration_seconds",
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toMatch(new RegExp(`# TYPE ${name} (counter|gauge|histogram)`));
    }
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("createLogger — text", () => {
  it("writes one compact line per request", () => {
    const { out, opts } = sink();
    const log = createLogger({ format: "text", quiet: false, now: AT, ...opts });
    log.request({
      from: "alice@example.org/x",
      method: "GET",
      resource: "/page",
      status: 200,
      durationMs: 12,
    });
    expect(out).toEqual(["[gateway] alice@example.org/x GET /page → 200 (12ms)"]);
  });

  it("sends errors to stderr, with the error's message", () => {
    const { out, err, opts } = sink();
    const log = createLogger({ format: "text", quiet: false, now: AT, ...opts });
    log.error("stream error", new Error("boom"));
    expect(out).toEqual([]);
    expect(err[0]).toContain("stream error");
    expect(err[0]).toContain("error=boom");
  });

  it("quiet drops info but keeps errors", () => {
    const { out, err, opts } = sink();
    const log = createLogger({ format: "text", quiet: true, now: AT, ...opts });
    log.info("serving");
    log.request({ from: "a@b", method: "GET", resource: "/", status: 200, durationMs: 1 });
    log.error("nope");
    expect(out).toEqual([]);
    expect(err.length).toBe(1);
  });
});

describe("createLogger — json", () => {
  it("emits one object per line with the fields as data", () => {
    const { out, opts } = sink();
    const log = createLogger({ format: "json", quiet: false, now: AT, ...opts });
    log.request({
      from: "alice@example.org/x",
      method: "GET",
      resource: "/page",
      status: 200,
      durationMs: 12,
    });
    expect(JSON.parse(out[0]!)).toEqual({
      ts: "2026-07-30T12:00:00.000Z",
      level: "info",
      msg: "request",
      from: "alice@example.org/x",
      method: "GET",
      resource: "/page",
      status: 200,
      durationMs: 12,
    });
  });

  it("keeps error details as fields, not interpolated text", () => {
    const { err, opts } = sink();
    const log = createLogger({ format: "json", quiet: false, now: AT, ...opts });
    log.error("handler error", new TypeError("bad input"));
    const entry = JSON.parse(err[0]!) as Record<string, unknown>;
    expect(entry["level"]).toBe("error");
    expect(entry["msg"]).toBe("handler error");
    expect(entry["error"]).toBe("bad input");
    expect(entry["errorName"]).toBe("TypeError");
  });

  it("survives a non-Error thrown value", () => {
    const { err, opts } = sink();
    const log = createLogger({ format: "json", quiet: false, now: AT, ...opts });
    log.error("odd", "just a string");
    expect((JSON.parse(err[0]!) as Record<string, unknown>)["error"]).toBe(
      "just a string",
    );
  });
});
