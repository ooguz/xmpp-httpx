import { createOriginProxyHandler } from "../node/origin-proxy.js";
import { allowAll, allowList, type AuthorizeFn } from "../server/policy.js";
import { HttpxServer } from "../server/server.js";
import type { XmppSession } from "../session.js";
import { stanzaBudgets } from "../transport/select.js";
import type { GatewayConfig } from "./config.js";
import { Metrics } from "./metrics.js";
import { startMetricsServer, type RunningMetricsServer } from "./metrics-server.js";

/**
 * Turns a validated config into a running gateway: an XMPP session (component
 * or client) with an `HttpxServer` reverse-proxying an HTTP origin, plus the
 * observability side — request logs, counters, and a /metrics + /healthz
 * listener when one is asked for.
 *
 * Exported separately from main.ts so the E2E suite can start a gateway in
 * process, against the real Prosody, without spawning the bin or needing a
 * build.
 */

export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

/** What the gateway logs per request; `createLogger` implements it. */
export interface RequestLogger extends Logger {
  request(fields: {
    from: string;
    method: string;
    resource: string;
    status?: number;
    durationMs?: number;
  }): void;
}

export interface RunningGateway {
  /** The JID requests should be addressed to. */
  jid: string;
  metrics: Metrics;
  /** Bound port of the metrics listener, when one was started. */
  metricsPort?: number;
  stop(): Promise<void>;
}

/** xmpp.js entities expose more than XmppSession; this is all we need. */
interface XmppEntity {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  on(event: string, listener: (arg: never) => void): unknown;
}

async function createEntity(
  config: GatewayConfig,
): Promise<{ entity: XmppEntity; jid: string }> {
  if (config.mode === "component") {
    const { component } = await importOptional<{
      component: (options: {
        service: string;
        domain: string;
        password: string;
      }) => XmppEntity;
    }>("@xmpp/component");
    return {
      entity: component({
        service: config.service,
        domain: config.domain!,
        password: config.secret!,
      }),
      jid: config.domain!,
    };
  }

  const { client } = await importOptional<{
    client: (options: {
      service: string;
      domain?: string;
      username?: string;
      password: string;
      resource?: string;
    }) => XmppEntity;
  }>("@xmpp/client");

  const [username = "", domain = ""] = config.jid!.split("@", 2);
  return {
    entity: client({
      service: config.service,
      domain,
      username,
      password: config.password!,
      resource: "httpx-gateway",
    }),
    jid: config.jid!,
  };
}

/**
 * The xmpp.js packages are *optional* peers of this library, so a missing one
 * is a normal situation to explain rather than a stack trace to print.
 */
async function importOptional<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (err) {
    throw new Error(
      `the gateway needs ${specifier}, which is not installed — run: npm install ${specifier}`,
      { cause: err },
    );
  }
}

/** Wraps the policy so refusals are counted and logged, not just returned. */
function observedAuthorize(
  authorize: AuthorizeFn,
  metrics: Metrics,
  log: Logger,
): AuthorizeFn {
  return async (from, req) => {
    const allowed = await authorize(from, req);
    if (!allowed) {
      metrics.recordDenied(from);
      log.error(`denied ${from} ${req.method} ${req.resource}`);
    }
    return allowed;
  };
}

export async function startGateway(
  config: GatewayConfig,
  log: RequestLogger,
  options: { version?: string } = {},
): Promise<RunningGateway> {
  const metrics = new Metrics({ version: options.version ?? "0.0.0" });
  const { entity, jid } = await createEntity(config);

  entity.on("error", (err: unknown) => {
    metrics.recordError("stream");
    log.error("stream error", err);
  });
  // xmpp.js emits these around (re)connection; they are the only liveness
  // signal the gateway has, and what /healthz reports.
  entity.on("online", () => {
    metrics.setStreamUp(true);
    log.info("stream online");
  });
  entity.on("offline", () => {
    metrics.setStreamUp(false);
    log.error("stream offline");
  });

  const budgets =
    config.maxStanzaBytes === undefined
      ? undefined
      : stanzaBudgets(config.maxStanzaBytes);

  const server = new HttpxServer(entity as unknown as XmppSession, {
    authorize: observedAuthorize(
      config.allow === "all" ? allowAll() : allowList(config.allow),
      metrics,
      log,
    ),
    compress: config.compress,
    onError: (err, context) => {
      metrics.recordError("handler");
      log.error(`handler error for ${context.from} ${context.resource ?? ""}`, err);
    },
    ...(budgets ? { inlineBudgetBytes: budgets.inlineBudgetBytes } : {}),
    ...(config.preferredStreams ? { preferredStreams: config.preferredStreams } : {}),
    ...(config.maxRequestBodyBytes !== undefined
      ? { maxRequestBodyBytes: config.maxRequestBodyBytes }
      : {}),
  });

  const proxy = createOriginProxyHandler(config.origin, {
    followRedirects: config.followRedirects,
    jidHeader: config.jidHeader,
  });

  server.handle(async (req) => {
    const started = Date.now();
    try {
      const response = await proxy(req);
      const status =
        response instanceof Response ? response.status : (response.status ?? 200);
      const durationMs = Date.now() - started;
      metrics.recordRequest(req.method, status, durationMs);
      log.request({
        from: req.from,
        method: req.method,
        resource: req.resource,
        status,
        durationMs,
      });
      return response;
    } catch (err) {
      // The server maps this to an IQ error; count it before it leaves.
      metrics.recordRequest(req.method, 502, Date.now() - started);
      metrics.recordError("origin");
      throw err;
    }
  });
  server.start();

  let metricsServer: RunningMetricsServer | undefined;
  if (config.metricsPort !== undefined) {
    metricsServer = await startMetricsServer(metrics, {
      port: config.metricsPort,
      address: config.metricsAddress,
    });
    log.info(
      `metrics on http://${config.metricsAddress}:${metricsServer.port}/metrics (also /healthz)`,
    );
  }

  await entity.start();
  metrics.setStreamUp(true);
  log.info(
    `serving ${config.origin} as httpx://${jid}/ ` +
      `(${config.allow === "all" ? "open to all" : `${config.allow.length} allowed JID(s)`})`,
  );

  return {
    jid,
    metrics,
    ...(metricsServer ? { metricsPort: metricsServer.port } : {}),
    async stop() {
      server.stop();
      await entity.stop();
      metrics.setStreamUp(false);
      await metricsServer?.close();
    },
  };
}
