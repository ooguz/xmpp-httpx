/**
 * A tiny Prometheus registry for the gateway: counters, one duration histogram,
 * and gauges, rendered in the text exposition format.
 *
 * Hand-rolled rather than pulling in a client library — the library ships with
 * one runtime dependency and the CLI should not change that for ~80 lines of
 * string building. Pure and clock-injected, so the output is asserted exactly
 * in tests.
 */

/** Seconds. Tuned for a transport where a fast request is tens of ms. */
export const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10] as const;

export interface MetricsOptions {
  /** Reported as a build_info label. */
  version: string;
  buckets?: readonly number[];
}

type Labels = Record<string, string>;

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const body = entries
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(",");
  return `{${body}}`;
}

/** Prometheus escaping for label values: backslash, quote, newline. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class Metrics {
  private readonly requests = new Map<string, { labels: Labels; count: number }>();
  private readonly denied = new Map<string, { labels: Labels; count: number }>();
  private readonly errors = new Map<string, { labels: Labels; count: number }>();
  private readonly buckets: readonly number[];
  private readonly bucketCounts: number[];
  private durationSum = 0;
  private durationCount = 0;
  private streamUp = 0;
  private readonly version: string;

  constructor(options: MetricsOptions) {
    this.version = options.version;
    this.buckets = options.buckets ?? DEFAULT_BUCKETS;
    this.bucketCounts = this.buckets.map(() => 0);
  }

  private static bump(
    into: Map<string, { labels: Labels; count: number }>,
    labels: Labels,
  ): void {
    const key = JSON.stringify(labels);
    const existing = into.get(key);
    if (existing) existing.count += 1;
    else into.set(key, { labels, count: 1 });
  }

  /** One handled request: counted by method and status, timed in the histogram. */
  recordRequest(method: string, status: number, durationMs: number): void {
    Metrics.bump(this.requests, { method, status: String(status) });
    const seconds = durationMs / 1000;
    this.durationSum += seconds;
    this.durationCount += 1;
    for (const [index, bound] of this.buckets.entries()) {
      if (seconds <= bound) this.bucketCounts[index]! += 1;
    }
  }

  /** A requester the authorization policy turned away. */
  recordDenied(from: string): void {
    // Label on the *bare* JID only: a resource is unbounded cardinality, and
    // metrics are not an audit log — the request log has the full JID.
    Metrics.bump(this.denied, { jid: from.split("/")[0] ?? from });
  }

  recordError(kind: string): void {
    Metrics.bump(this.errors, { kind });
  }

  setStreamUp(up: boolean): void {
    this.streamUp = up ? 1 : 0;
  }

  /** True when the XMPP stream is connected — what /healthz answers with. */
  get healthy(): boolean {
    return this.streamUp === 1;
  }

  render(): string {
    const lines: string[] = [];

    const metric = (
      name: string,
      help: string,
      type: string,
      samples: { labels: Labels; value: number }[],
    ): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const { labels, value } of samples) {
        lines.push(`${name}${renderLabels(labels)} ${value}`);
      }
    };

    metric("httpx_gateway_build_info", "Gateway version, as a label.", "gauge", [
      { labels: { version: this.version }, value: 1 },
    ]);
    metric(
      "httpx_gateway_stream_up",
      "1 when the XMPP stream is connected, 0 otherwise.",
      "gauge",
      [{ labels: {}, value: this.streamUp }],
    );
    metric(
      "httpx_gateway_requests_total",
      "Requests answered, by method and response status.",
      "counter",
      [...this.requests.values()].map((entry) => ({
        labels: entry.labels,
        value: entry.count,
      })),
    );
    metric(
      "httpx_gateway_requests_denied_total",
      "Requests refused by the authorization policy, by bare JID.",
      "counter",
      [...this.denied.values()].map((entry) => ({
        labels: entry.labels,
        value: entry.count,
      })),
    );
    metric(
      "httpx_gateway_errors_total",
      "Errors, by kind.",
      "counter",
      [...this.errors.values()].map((entry) => ({
        labels: entry.labels,
        value: entry.count,
      })),
    );

    const duration = "httpx_gateway_request_duration_seconds";
    lines.push(
      `# HELP ${duration} Time to answer a request, in seconds.`,
      `# TYPE ${duration} histogram`,
    );
    for (const [index, bound] of this.buckets.entries()) {
      lines.push(`${duration}_bucket{le="${bound}"} ${this.bucketCounts[index]!}`);
    }
    lines.push(
      `${duration}_bucket{le="+Inf"} ${this.durationCount}`,
      `${duration}_sum ${this.durationSum}`,
      `${duration}_count ${this.durationCount}`,
    );

    return `${lines.join("\n")}\n`;
  }
}
