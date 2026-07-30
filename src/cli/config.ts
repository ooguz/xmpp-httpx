import {
  isStreamMechanism,
  type StreamMechanism,
} from "../transport/select.js";

/**
 * Configuration for the gateway CLI: flags, config file, and environment
 * merged into one validated object.
 *
 * Deliberately pure — no `process`, no filesystem, no XMPP. The caller passes
 * argv, the file's contents, and the environment; everything here is testable
 * in either vitest project, and the Node-only work lives in gateway.ts/main.ts.
 */

export type Allow = readonly string[] | "all";

export interface GatewayConfig {
  /** XEP-0114 component, or a normal client account. */
  mode: "component" | "client";
  /** XMPP service URI: xmpp://host:port for components, ws(s):// for clients. */
  service: string;
  /** HTTP origin to reverse-proxy. */
  origin: string;
  /** Component domain (component mode). */
  domain?: string;
  secret?: string;
  /** Account JID (client mode). */
  jid?: string;
  password?: string;
  /** Bare JIDs allowed to make requests, or "all". */
  allow: Allow;
  maxStanzaBytes?: number;
  preferredStreams?: readonly StreamMechanism[];
  compress: boolean;
  /** Header carrying the requester's JID to the origin; false to omit. */
  jidHeader: string | false;
  followRedirects: boolean;
  maxRequestBodyBytes?: number;
  quiet: boolean;
  /** Human lines, or one JSON object per line for a log shipper. */
  logFormat: "text" | "json";
  /** Port for /metrics and /healthz; omitted means no listener at all. */
  metricsPort?: number;
  /** Interface for that listener. Defaults to loopback, deliberately. */
  metricsAddress: string;
}

export type ParseResult =
  | { kind: "config"; config: GatewayConfig; warnings: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "errors"; errors: string[] };

/** Raw values from one source, before validation. */
interface Fields {
  service?: string;
  origin?: string;
  domain?: string;
  secret?: string;
  jid?: string;
  password?: string;
  allow?: string[];
  allowAll?: boolean;
  maxStanzaBytes?: number;
  preferredStreams?: string[];
  compress?: boolean;
  jidHeader?: string | false;
  followRedirects?: boolean;
  maxRequestBodyBytes?: number;
  quiet?: boolean;
  logFormat?: "text" | "json";
  metricsPort?: number;
  metricsAddress?: string;
  configPath?: string;
}

export const USAGE = `xmpp-httpx-gateway — put an HTTP origin on XMPP (XEP-0332)

Usage:
  xmpp-httpx-gateway --origin <url> --service <uri> --domain <domain> --secret <s>
  xmpp-httpx-gateway --origin <url> --service <uri> --jid <jid> --password <p>
  xmpp-httpx-gateway --config gateway.json

Required:
  --origin <url>          HTTP origin to reverse-proxy (http://localhost:8080)
  --service <uri>         XMPP service (xmpp://host:5347, wss://host/xmpp-websocket)
  and one authentication mode:
  --domain <domain>       component domain, with --secret   (XEP-0114)
  --jid <jid>             account JID, with --password      (c2s client)

Authorization (one is required — the library denies by default):
  --allow <jid[,jid]>     bare JIDs allowed to request; repeatable
  --allow-all             serve every requester (public gateway)

Options:
  --config <file>         JSON config file; flags and env override it
  --max-stanza <bytes>    derive inline/chunk budgets from the stream limit
  --prefer <mechs>        stream preference, e.g. ibb,chunkedBase64,sipub
  --max-body <bytes>      cap on request bodies (default 8 MiB)
  --jid-header <name>     header carrying the requester JID (default x-httpx-from)
  --no-jid-header         do not tell the origin who is asking
  --no-compress           disable gzip/deflate Content-Encoding
  --follow-redirects      follow origin redirects instead of forwarding them
  --log-format <fmt>      text (default) or json, one object per line
  --metrics-port <port>   serve /metrics (Prometheus) and /healthz
  --metrics-address <ip>  interface for that listener (default 127.0.0.1)
  --quiet                 log only errors
  -h, --help              this text
  -v, --version           print the version

Environment (preferred over flags for secrets — argv is visible in ps):
  XMPP_HTTPX_SECRET, XMPP_HTTPX_PASSWORD

Precedence: flags > environment > config file > defaults.`;

const FLAGS_WITH_VALUE = new Set([
  "--config",
  "--origin",
  "--service",
  "--domain",
  "--secret",
  "--jid",
  "--password",
  "--allow",
  "--max-stanza",
  "--prefer",
  "--max-body",
  "--jid-header",
  "--log-format",
  "--metrics-port",
  "--metrics-address",
]);

/** Parses argv into raw fields; unknown flags and bad numbers are errors. */
function parseArgv(argv: readonly string[]): { fields: Fields; errors: string[] } {
  const fields: Fields = {};
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (FLAGS_WITH_VALUE.has(arg)) {
      value = argv[++i];
      if (value === undefined) {
        errors.push(`${arg} needs a value`);
        continue;
      }
    }

    const number = (raw: string): number | undefined => {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        errors.push(`${arg} needs a positive integer, got "${raw}"`);
        return undefined;
      }
      return parsed;
    };

    switch (arg) {
      case "--config":
        fields.configPath = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--origin":
        fields.origin = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--service":
        fields.service = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--domain":
        fields.domain = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--secret":
        fields.secret = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--jid":
        fields.jid = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--password":
        fields.password = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--allow":
        fields.allow = [...(fields.allow ?? []), ...splitList(value!)];
        break;
      case "--allow-all":
        fields.allowAll = true;
        break;
      case "--max-stanza": {
        const parsed = number(value!);
        if (parsed !== undefined) fields.maxStanzaBytes = parsed;
        break;
      }
      case "--max-body": {
        const parsed = number(value!);
        if (parsed !== undefined) fields.maxRequestBodyBytes = parsed;
        break;
      }
      case "--prefer":
        fields.preferredStreams = splitList(value!);
        break;
      case "--jid-header":
        fields.jidHeader = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--no-jid-header":
        fields.jidHeader = false;
        break;
      case "--no-compress":
        fields.compress = false;
        break;
      case "--log-format":
        if (value === "text" || value === "json") fields.logFormat = value;
        else errors.push(`--log-format must be "text" or "json", got "${value!}"`);
        break;
      case "--metrics-port": {
        const parsed = number(value!);
        if (parsed !== undefined) {
          if (parsed > 65535) errors.push(`--metrics-port out of range: ${parsed}`);
          else fields.metricsPort = parsed;
        }
        break;
      }
      case "--metrics-address":
        fields.metricsAddress = value!; // FLAGS_WITH_VALUE guarantees it
        break;
      case "--follow-redirects":
        fields.followRedirects = true;
        break;
      case "--quiet":
        fields.quiet = true;
        break;
      default:
        errors.push(`unknown option "${arg}"`);
    }
  }

  return { fields, errors };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Reads the JSON config file's fields, rejecting values of the wrong type. */
function parseFile(contents: string): { fields: Fields; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    return { fields: {}, errors: [`config file is not valid JSON: ${String(err)}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { fields: {}, errors: ["config file must contain a JSON object"] };
  }

  const errors: string[] = [];
  const fields: Fields = {};
  const source = parsed as Record<string, unknown>;

  const string = (key: string): string | undefined => {
    const value = source[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      errors.push(`config "${key}" must be a string`);
      return undefined;
    }
    return value;
  };
  const positive = (key: string): number | undefined => {
    const value = source[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      errors.push(`config "${key}" must be a positive integer`);
      return undefined;
    }
    return value;
  };
  const boolean = (key: string): boolean | undefined => {
    const value = source[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      errors.push(`config "${key}" must be a boolean`);
      return undefined;
    }
    return value;
  };
  const stringList = (key: string): string[] | undefined => {
    const value = source[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      errors.push(`config "${key}" must be an array of strings`);
      return undefined;
    }
    return value as string[];
  };

  assign(fields, "service", string("service"));
  assign(fields, "origin", string("origin"));
  assign(fields, "domain", string("domain"));
  assign(fields, "secret", string("secret"));
  assign(fields, "jid", string("jid"));
  assign(fields, "password", string("password"));
  assign(fields, "maxStanzaBytes", positive("maxStanzaBytes"));
  assign(fields, "maxRequestBodyBytes", positive("maxRequestBodyBytes"));
  assign(fields, "compress", boolean("compress"));
  assign(fields, "followRedirects", boolean("followRedirects"));
  assign(fields, "quiet", boolean("quiet"));
  assign(fields, "metricsPort", positive("metricsPort"));
  assign(fields, "metricsAddress", string("metricsAddress"));

  const logFormat = source["logFormat"];
  if (logFormat !== undefined) {
    if (logFormat === "text" || logFormat === "json") fields.logFormat = logFormat;
    else errors.push('config "logFormat" must be "text" or "json"');
  }
  assign(fields, "preferredStreams", stringList("preferredStreams"));

  const allow = source["allow"];
  if (allow === "all") fields.allowAll = true;
  else assign(fields, "allow", stringList("allow"));

  const jidHeader = source["jidHeader"];
  if (jidHeader === false) fields.jidHeader = false;
  else assign(fields, "jidHeader", string("jidHeader"));

  return { fields, errors };
}

function assign<K extends keyof Fields>(
  fields: Fields,
  key: K,
  value: Fields[K] | undefined,
): void {
  if (value !== undefined) fields[key] = value;
}

/** Later sources win, key by key. */
function merge(...sources: Fields[]): Fields {
  const merged: Fields = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

export interface ParseInputs {
  argv: readonly string[];
  /** Contents of the file named by --config, if any. */
  configFile?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Turns inputs into a validated config, or into the errors a user needs to see.
 * `--config` is reported through `configPathOf` first, so the caller can read
 * the file and call again with its contents.
 */
export function parseConfig(inputs: ParseInputs): ParseResult {
  const { argv } = inputs;
  if (argv.includes("-h") || argv.includes("--help")) return { kind: "help" };
  if (argv.includes("-v") || argv.includes("--version")) return { kind: "version" };

  const fromArgv = parseArgv(argv);
  const fromFile =
    inputs.configFile === undefined
      ? { fields: {}, errors: [] }
      : parseFile(inputs.configFile);

  const env = inputs.env ?? {};
  const fromEnv: Fields = {};
  assign(fromEnv, "secret", env["XMPP_HTTPX_SECRET"]);
  assign(fromEnv, "password", env["XMPP_HTTPX_PASSWORD"]);

  const fields = merge(fromFile.fields, fromEnv, fromArgv.fields);
  const errors = [...fromFile.errors, ...fromArgv.errors];
  const warnings: string[] = [];

  if (!fields.origin) errors.push("--origin is required");
  if (!fields.service) errors.push("--service is required");

  const component = Boolean(fields.domain ?? fields.secret);
  const client = Boolean(fields.jid ?? fields.password);
  if (component && client) {
    errors.push("choose one mode: --domain/--secret (component) or --jid/--password");
  } else if (component) {
    if (!fields.domain) errors.push("--domain is required in component mode");
    if (!fields.secret) errors.push("--secret is required in component mode");
  } else if (client) {
    if (!fields.jid) errors.push("--jid is required in client mode");
    if (!fields.password) errors.push("--password is required in client mode");
  } else {
    errors.push("no authentication given: use --domain/--secret or --jid/--password");
  }

  // The library denies by default and so does the CLI: serving strangers has to
  // be typed out, never inherited from a half-written config.
  if (fields.allowAll && fields.allow?.length) {
    errors.push("--allow-all and --allow are mutually exclusive");
  } else if (!fields.allowAll && !fields.allow?.length) {
    errors.push("no authorization given: use --allow <jid> or --allow-all");
  }

  const mechanisms: StreamMechanism[] = [];
  for (const entry of fields.preferredStreams ?? []) {
    if (isStreamMechanism(entry)) mechanisms.push(entry);
    else errors.push(`unknown stream mechanism "${entry}"`);
  }

  if (argv.includes("--secret") || argv.includes("--password")) {
    warnings.push(
      "secret passed on the command line is visible to other processes; prefer XMPP_HTTPX_SECRET/XMPP_HTTPX_PASSWORD or a config file",
    );
  }

  if (errors.length > 0) return { kind: "errors", errors };

  const config: GatewayConfig = {
    mode: component ? "component" : "client",
    service: fields.service!,
    origin: fields.origin!,
    allow: fields.allowAll ? "all" : (fields.allow ?? []),
    compress: fields.compress ?? true,
    jidHeader: fields.jidHeader ?? "x-httpx-from",
    followRedirects: fields.followRedirects ?? false,
    quiet: fields.quiet ?? false,
    logFormat: fields.logFormat ?? "text",
    metricsAddress: fields.metricsAddress ?? "127.0.0.1",
    ...(fields.metricsPort !== undefined ? { metricsPort: fields.metricsPort } : {}),
    ...(fields.domain !== undefined ? { domain: fields.domain } : {}),
    ...(fields.secret !== undefined ? { secret: fields.secret } : {}),
    ...(fields.jid !== undefined ? { jid: fields.jid } : {}),
    ...(fields.password !== undefined ? { password: fields.password } : {}),
    ...(fields.maxStanzaBytes !== undefined
      ? { maxStanzaBytes: fields.maxStanzaBytes }
      : {}),
    ...(fields.maxRequestBodyBytes !== undefined
      ? { maxRequestBodyBytes: fields.maxRequestBodyBytes }
      : {}),
    ...(mechanisms.length > 0 ? { preferredStreams: mechanisms } : {}),
  };

  return { kind: "config", config, warnings };
}

/** The `--config <file>` path, if the arguments name one. */
export function configPathOf(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--config");
  return index === -1 ? undefined : argv[index + 1];
}
