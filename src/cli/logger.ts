import type { Logger } from "./gateway.js";

/**
 * The gateway's logging: one human line per event, or one JSON object per line
 * for a log shipper. Structured fields are carried explicitly rather than
 * scraped back out of a message string.
 *
 * The sink and clock are injected so tests assert exact output.
 */

export type LogFormat = "text" | "json";

export interface LogFields {
  /** Requester's full JID. */
  from?: string;
  method?: string;
  resource?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface StructuredLogger extends Logger {
  /** A handled request — the one high-volume event, hence its own method. */
  request(fields: LogFields & { from: string; method: string; resource: string }): void;
}

export interface LoggerOptions {
  format: LogFormat;
  /** Suppress info-level output; errors are always written. */
  quiet: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error === undefined) return {};
  if (error instanceof Error) {
    return {
      error: error.message,
      errorName: error.name,
      ...(error.cause !== undefined ? { cause: String(error.cause) } : {}),
    };
  }
  return { error: String(error) };
}

export function createLogger(options: LoggerOptions): StructuredLogger {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());

  const emit = (
    level: "info" | "error",
    message: string,
    fields: Record<string, unknown>,
  ): void => {
    const write = level === "error" ? err : out;
    if (level === "info" && options.quiet) return;

    if (options.format === "json") {
      write(
        JSON.stringify({
          ts: now().toISOString(),
          level,
          msg: message,
          ...fields,
        }),
      );
      return;
    }

    const extra = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : String(value)}`)
      .join(" ");
    write(`[gateway] ${message}${extra === "" ? "" : ` ${extra}`}`);
  };

  return {
    info(message) {
      emit("info", message, {});
    },
    error(message, error) {
      emit("error", message, errorFields(error));
    },
    request(fields) {
      const { from, method, resource, status, durationMs, ...rest } = fields;
      if (options.format === "json") {
        emit("info", "request", { from, method, resource, status, durationMs, ...rest });
        return;
      }
      // Text mode keeps the compact one-liner: alice@x GET /p → 200 (4ms)
      emit(
        "info",
        `${from} ${method} ${resource} → ${status ?? "?"} (${durationMs ?? "?"}ms)`,
        rest,
      );
    },
  };
}
