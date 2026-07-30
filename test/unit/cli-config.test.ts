import { describe, expect, it } from "vitest";
import { configPathOf, parseConfig } from "../../src/cli/config.js";

const BASE = [
  "--origin",
  "http://localhost:8080",
  "--service",
  "xmpp://localhost:5347",
  "--domain",
  "web.example.org",
  "--secret",
  "s3cret",
  "--allow",
  "alice@example.org",
];

/** Parses and asserts success, returning the config. */
function ok(argv: string[], extra: Partial<Parameters<typeof parseConfig>[0]> = {}) {
  const result = parseConfig({ argv, ...extra });
  if (result.kind !== "config") {
    throw new Error(`expected a config, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  return result;
}

/** Parses and asserts failure, returning the messages. */
function errors(argv: string[], extra: Partial<Parameters<typeof parseConfig>[0]> = {}) {
  const result = parseConfig({ argv, ...extra });
  if (result.kind !== "errors") {
    throw new Error(`expected errors, got ${result.kind}`);
  }
  return result.errors;
}

describe("parseConfig — modes", () => {
  it("accepts a component gateway", () => {
    const { config } = ok(BASE);
    expect(config.mode).toBe("component");
    expect(config.service).toBe("xmpp://localhost:5347");
    expect(config.origin).toBe("http://localhost:8080");
    expect(config.domain).toBe("web.example.org");
    expect(config.secret).toBe("s3cret");
    expect(config.allow).toEqual(["alice@example.org"]);
  });

  it("accepts a client gateway", () => {
    const { config } = ok([
      "--origin",
      "http://localhost:8080",
      "--service",
      "wss://example.org/xmpp-websocket",
      "--jid",
      "gateway@example.org",
      "--password",
      "pw",
      "--allow-all",
    ]);
    expect(config.mode).toBe("client");
    expect(config.jid).toBe("gateway@example.org");
    expect(config.allow).toBe("all");
  });

  it("refuses both modes at once", () => {
    expect(errors([...BASE, "--jid", "a@b", "--password", "p"])).toContain(
      "choose one mode: --domain/--secret (component) or --jid/--password",
    );
  });

  it("refuses a half-specified mode", () => {
    expect(
      errors(["--origin", "http://o", "--service", "xmpp://s", "--domain", "d", "--allow-all"]),
    ).toContain("--secret is required in component mode");
    expect(
      errors(["--origin", "http://o", "--service", "xmpp://s", "--jid", "a@b", "--allow-all"]),
    ).toContain("--password is required in client mode");
  });

  it("requires an origin, a service, and authentication", () => {
    const messages = errors([]);
    expect(messages).toContain("--origin is required");
    expect(messages).toContain("--service is required");
    expect(messages).toContain(
      "no authentication given: use --domain/--secret or --jid/--password",
    );
  });
});

describe("parseConfig — authorization is never implicit", () => {
  it("refuses to run without an explicit decision", () => {
    const argv = BASE.filter((arg) => arg !== "--allow" && arg !== "alice@example.org");
    expect(errors(argv)).toContain(
      "no authorization given: use --allow <jid> or --allow-all",
    );
  });

  it("refuses --allow-all together with --allow", () => {
    expect(errors([...BASE, "--allow-all"])).toContain(
      "--allow-all and --allow are mutually exclusive",
    );
  });

  it("accumulates repeated and comma-separated --allow", () => {
    const { config } = ok([
      ...BASE,
      "--allow",
      "bob@example.org, carol@example.org",
      "--allow",
      "dave@example.org",
    ]);
    expect(config.allow).toEqual([
      "alice@example.org",
      "bob@example.org",
      "carol@example.org",
      "dave@example.org",
    ]);
  });
});

describe("parseConfig — options", () => {
  it("defaults compress on, redirects off, and the JID header", () => {
    const { config } = ok(BASE);
    expect(config.compress).toBe(true);
    expect(config.followRedirects).toBe(false);
    expect(config.jidHeader).toBe("x-httpx-from");
    expect(config.quiet).toBe(false);
  });

  it("honors the negations and overrides", () => {
    const { config } = ok([
      ...BASE,
      "--no-compress",
      "--no-jid-header",
      "--follow-redirects",
      "--quiet",
    ]);
    expect(config.compress).toBe(false);
    expect(config.jidHeader).toBe(false);
    expect(config.followRedirects).toBe(true);
    expect(config.quiet).toBe(true);
  });

  it("takes a custom JID header name", () => {
    expect(ok([...BASE, "--jid-header", "x-who"]).config.jidHeader).toBe("x-who");
  });

  it("parses byte counts and rejects nonsense", () => {
    const { config } = ok([...BASE, "--max-stanza", "65536", "--max-body", "1024"]);
    expect(config.maxStanzaBytes).toBe(65536);
    expect(config.maxRequestBodyBytes).toBe(1024);

    expect(errors([...BASE, "--max-stanza", "lots"])).toContain(
      '--max-stanza needs a positive integer, got "lots"',
    );
    expect(errors([...BASE, "--max-body", "-5"])).toContain(
      '--max-body needs a positive integer, got "-5"',
    );
  });

  it("validates stream mechanisms", () => {
    expect(ok([...BASE, "--prefer", "ibb,sipub"]).config.preferredStreams).toEqual([
      "ibb",
      "sipub",
    ]);
    expect(errors([...BASE, "--prefer", "ibb,carrier-pigeon"])).toContain(
      'unknown stream mechanism "carrier-pigeon"',
    );
  });

  it("reports unknown flags and missing values", () => {
    expect(errors([...BASE, "--turbo"])).toContain('unknown option "--turbo"');
    expect(errors(["--origin"])).toContain("--origin needs a value");
  });
});

describe("parseConfig — sources and precedence", () => {
  const FILE = JSON.stringify({
    service: "xmpp://file:5347",
    origin: "http://file:8080",
    domain: "file.example.org",
    secret: "file-secret",
    allow: ["file@example.org"],
    compress: false,
    maxStanzaBytes: 4096,
  });

  it("reads everything from a config file", () => {
    const { config } = ok([], { configFile: FILE });
    expect(config.origin).toBe("http://file:8080");
    expect(config.domain).toBe("file.example.org");
    expect(config.compress).toBe(false);
    expect(config.maxStanzaBytes).toBe(4096);
    expect(config.allow).toEqual(["file@example.org"]);
  });

  it("lets flags win over the file, and the file fill the gaps", () => {
    const { config } = ok(["--origin", "http://flag:9090"], { configFile: FILE });
    expect(config.origin).toBe("http://flag:9090");
    expect(config.service).toBe("xmpp://file:5347");
  });

  it("lets the environment win over the file but lose to flags", () => {
    const withEnv = ok([], {
      configFile: FILE,
      env: { XMPP_HTTPX_SECRET: "env-secret" },
    });
    expect(withEnv.config.secret).toBe("env-secret");

    const withFlag = ok(["--secret", "flag-secret"], {
      configFile: FILE,
      env: { XMPP_HTTPX_SECRET: "env-secret" },
    });
    expect(withFlag.config.secret).toBe("flag-secret");
  });

  it("supports allow: \"all\" in the file", () => {
    const { config } = ok([], {
      configFile: JSON.stringify({
        service: "xmpp://s",
        origin: "http://o",
        domain: "d",
        secret: "s",
        allow: "all",
      }),
    });
    expect(config.allow).toBe("all");
  });

  it("reports malformed files rather than guessing", () => {
    expect(errors([], { configFile: "{ not json" })[0]).toMatch(/not valid JSON/);
    expect(errors([], { configFile: "[]" })).toContain(
      "config file must contain a JSON object",
    );
    expect(
      errors([], { configFile: JSON.stringify({ origin: 42, maxStanzaBytes: "big" }) }),
    ).toEqual(
      expect.arrayContaining([
        'config "origin" must be a string',
        'config "maxStanzaBytes" must be a positive integer',
      ]),
    );
  });

  it("warns when a secret comes from argv, where other processes can see it", () => {
    expect(ok(BASE).warnings[0]).toMatch(/visible to other processes/);
    expect(
      ok(BASE.filter((a) => a !== "--secret" && a !== "s3cret"), {
        env: { XMPP_HTTPX_SECRET: "quiet" },
      }).warnings,
    ).toEqual([]);
  });
});

describe("parseConfig — help and version", () => {
  it("short-circuits on --help and --version", () => {
    expect(parseConfig({ argv: ["--help"] }).kind).toBe("help");
    expect(parseConfig({ argv: ["-h", "--origin", "x"] }).kind).toBe("help");
    expect(parseConfig({ argv: ["--version"] }).kind).toBe("version");
    expect(parseConfig({ argv: ["-v"] }).kind).toBe("version");
  });
});

describe("configPathOf", () => {
  it("finds the config path before anything is validated", () => {
    expect(configPathOf(["--config", "gateway.json", "--quiet"])).toBe("gateway.json");
    expect(configPathOf(["--quiet"])).toBeUndefined();
    expect(configPathOf(["--config"])).toBeUndefined();
  });
});
