import { readFile } from "node:fs/promises";
import { configPathOf, parseConfig, USAGE } from "./config.js";
import { startGateway } from "./gateway.js";
import { createLogger } from "./logger.js";

/**
 * The `xmpp-httpx-gateway` entry point: everything Node-specific and
 * process-shaped (argv, env, files, signals, exit codes) lives here, so
 * config.ts stays pure and gateway.ts stays embeddable.
 */

const VERSION = "0.6.0";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const configPath = configPathOf(argv);

  let configFile: string | undefined;
  if (configPath !== undefined) {
    try {
      configFile = await readFile(configPath, "utf8");
    } catch (err) {
      console.error(`[gateway] cannot read config file "${configPath}": ${String(err)}`);
      return 2;
    }
  }

  const result = parseConfig({
    argv,
    env: process.env,
    ...(configFile !== undefined ? { configFile } : {}),
  });

  if (result.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (result.kind === "version") {
    console.log(VERSION);
    return 0;
  }
  if (result.kind === "errors") {
    for (const error of result.errors) console.error(`[gateway] ${error}`);
    console.error("\nRun with --help for usage.");
    return 2;
  }

  const log = createLogger({
    format: result.config.logFormat,
    quiet: result.config.quiet,
  });
  for (const warning of result.warnings) log.error(`warning: ${warning}`);

  let gateway;
  try {
    gateway = await startGateway(result.config, log, { version: VERSION });
  } catch (err) {
    log.error("failed to start", err);
    return 1;
  }

  // Shut the stream down cleanly so the server sees a proper unavailable
  // presence / stream close rather than a dropped socket.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} — shutting down`);
    void gateway
      .stop()
      .catch((err: unknown) => log.error("error while stopping", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return -1; // keep running; the signal handlers own the exit
}

const code = await main();
if (code >= 0) process.exit(code);
