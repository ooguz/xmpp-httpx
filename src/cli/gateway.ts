import { createOriginProxyHandler } from "../node/origin-proxy.js";
import { allowAll, allowList } from "../server/policy.js";
import { HttpxServer } from "../server/server.js";
import type { XmppSession } from "../session.js";
import { stanzaBudgets } from "../transport/select.js";
import type { GatewayConfig } from "./config.js";

/**
 * Turns a validated config into a running gateway: an XMPP session (component
 * or client) with an `HttpxServer` reverse-proxying an HTTP origin.
 *
 * Exported separately from main.ts so the E2E suite can start a gateway in
 * process, against the real Prosody, without spawning the bin or needing a
 * build.
 */

export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface RunningGateway {
  /** The JID requests should be addressed to. */
  jid: string;
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

export async function startGateway(
  config: GatewayConfig,
  log: Logger,
): Promise<RunningGateway> {
  const { entity, jid } = await createEntity(config);
  entity.on("error", (err: unknown) => log.error("stream error", err));

  const budgets =
    config.maxStanzaBytes === undefined
      ? undefined
      : stanzaBudgets(config.maxStanzaBytes);

  const server = new HttpxServer(entity as unknown as XmppSession, {
    authorize: config.allow === "all" ? allowAll() : allowList(config.allow),
    compress: config.compress,
    onError: (err, context) =>
      log.error(`handler error for ${context.from} ${context.resource ?? ""}`, err),
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
    const response = await proxy(req);
    const status = response instanceof Response ? response.status : (response.status ?? 200);
    log.info(
      `${req.from} ${req.method} ${req.resource} → ${status} (${Date.now() - started}ms)`,
    );
    return response;
  });
  server.start();

  await entity.start();
  log.info(
    `serving ${config.origin} as httpx://${jid}/ ` +
      `(${config.allow === "all" ? "open to all" : `${config.allow.length} allowed JID(s)`})`,
  );

  return {
    jid,
    async stop() {
      server.stop();
      await entity.stop();
    },
  };
}
