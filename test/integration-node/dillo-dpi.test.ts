import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { createKeyFileAuth, loadConfig, saveConfig, type DpiConfig } from "../../examples/dillo/src/config.js";
import {
  configFromQuery,
  handleLocal,
  isLocalUrl,
  loggableUrl,
  splitLocalUrl,
} from "../../examples/dillo/src/settings.js";
import { buildTag, parseTag, TagBuffer } from "../../examples/dillo/src/dpip.js";
import {
  DpiSetupError,
  formatHead,
  serveConnection,
  type ServeOptions,
} from "../../examples/dillo/src/serve.js";
import { httpxFetch } from "../../src/client/fetch.js";
import { HttpxError } from "../../src/errors.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { createSessionPair } from "../../src/testing/index.js";

/**
 * The Dillo plugin, driven the way dpid and Dillo drive it: a TCP connection,
 * an `auth` tag, an `open_url` tag, then the bytes back. The XMPP side is the
 * in-memory session pair, so this proves the dpip/HTTP framing and the error
 * paths without a Dillo, a dpid or a Prosody anywhere. The real-dpid,
 * real-Dillo run is `scripts/smoke-dillo.mjs`.
 */

const SECRET = "5f4dcc3b5aa765d61d8327deb882cf99";

describe("dpip tags", () => {
  it("builds tags the way a_Dpip_build_cmd does, doubling quotes", () => {
    expect(buildTag({ cmd: "open_url", url: "httpx://web@example.org/" })).toBe(
      "<cmd='open_url' url='httpx://web@example.org/' '>",
    );
    expect(buildTag({ cmd: "send_status_message", msg: "it's here" })).toBe(
      "<cmd='send_status_message' msg='it''s here' '>",
    );
    expect(() => buildTag({ "bad name": "x" })).toThrow(TypeError);
  });

  it("parses what it builds, and what Dillo sends", () => {
    const attrs = { cmd: "open_url", url: "httpx://a@b/p?q='x'&r=''" };
    expect(parseTag(buildTag(attrs))).toEqual(attrs);
    expect(parseTag(`<cmd='auth' msg='${SECRET}' '>`)).toEqual({ cmd: "auth", msg: SECRET });
    expect(parseTag("<cmd='DpiBye' '>")).toEqual({ cmd: "DpiBye" });
    expect(() => parseTag("<cmd='open_url' url='unterminated")).toThrow(TypeError);
    expect(() => parseTag("cmd='x' '>")).toThrow(TypeError);
  });

  it("reassembles a tag split across chunks and keeps the payload byte-exact", () => {
    const buffer = new TagBuffer();
    const wire = new TextEncoder().encode(
      "<cmd='start_send_page' url='httpx://x/' '>HTTP/1.1 200 OK\r\n\r\nbody",
    );
    buffer.push(wire.subarray(0, 10));
    expect(buffer.nextTag()).toBeNull();
    buffer.push(wire.subarray(10, 30));
    expect(buffer.nextTag()).toBeNull();
    buffer.push(wire.subarray(30));
    expect(buffer.nextTag()).toEqual({ cmd: "start_send_page", url: "httpx://x/" });
    expect(new TextDecoder().decode(buffer.rest())).toBe("HTTP/1.1 200 OK\r\n\r\nbody");
  });

  it("refuses to buffer without bound while waiting for a terminator", () => {
    const buffer = new TagBuffer(64);
    expect(() => buffer.push(new Uint8Array(65).fill(0x61))).toThrow(RangeError);
  });
});

describe("dpid_comm_keys", () => {
  it("reads the key the way a_Dpip_check_auth does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "httpx-dpi-"));
    const file = join(dir, "dpid_comm_keys");
    await writeFile(file, `5000 ${SECRET}\n`);
    const check = createKeyFileAuth(file);
    expect(await check(SECRET)).toBe(true);
    expect(await check(SECRET.slice(0, -1))).toBe(false);
    expect(await check(`${SECRET}0`)).toBe(false);
    expect(await check("")).toBe(false);
    expect(await createKeyFileAuth(join(dir, "missing"))(SECRET)).toBe(false);
  });
});

describe("httpx.json", () => {
  it("validates the fields the plugin needs and explains what is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "httpx-dpi-"));
    const file = join(dir, "httpx.json");
    await expect(loadConfig(file)).rejects.toBeInstanceOf(DpiSetupError);
    await writeFile(file, "{");
    await expect(loadConfig(file)).rejects.toThrow(/valid JSON/);
    await writeFile(file, JSON.stringify({ jid: "nope", password: "x" }));
    await expect(loadConfig(file)).rejects.toThrow(/bare JID/);
    await writeFile(file, JSON.stringify({ jid: "alice@example.org", password: "pw" }));
    expect(await loadConfig(file)).toEqual({
      jid: "alice@example.org",
      password: "pw",
      service: undefined,
      resource: "dillo",
      timeoutMs: 30_000,
    });
  });
});

describe("httpx.json round trip", () => {
  it("writes what loadConfig reads, mode 600, and omits an absent service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "httpx-dpi-"));
    const file = join(dir, "nested", "httpx.json");
    const config: DpiConfig = {
      jid: "alice@example.org",
      password: "pw",
      service: undefined,
      resource: "dillo",
      timeoutMs: 5000,
    };
    await saveConfig(file, config);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("service");
    expect(await loadConfig(file)).toEqual(config);
  });
});

describe("dpi:/httpx/ pages", () => {
  it("recognizes its own URLs and never logs their query", () => {
    expect(isLocalUrl("dpi:/httpx/")).toBe(true);
    expect(isLocalUrl("dpi:/httpx/save?password=hunter2")).toBe(true);
    expect(isLocalUrl("dpi:/httpxx/")).toBe(false);
    expect(isLocalUrl("httpx://web@example.org/")).toBe(false);
    expect(splitLocalUrl("dpi:/httpx/save?jid=a%40b&password=x")).toEqual({
      path: "/save",
      query: new URLSearchParams("jid=a%40b&password=x"),
    });
    expect(loggableUrl("dpi:/httpx/save?password=hunter2")).toBe("dpi:/httpx/save");
    expect(loggableUrl("httpx://web@example.org/?q=1")).toBe("httpx://web@example.org/?q=1");
  });

  it("turns the form into a config and keeps the stored password when the field is empty", () => {
    const current: DpiConfig = {
      jid: "old@example.org",
      password: "kept",
      service: "wss://example.org/ws",
      resource: "dillo",
      timeoutMs: 30_000,
    };
    expect(configFromQuery(new URLSearchParams("jid=alice@example.org&password=&service=&resource="), current)).toEqual({
      config: { jid: "alice@example.org", password: "kept", service: undefined, resource: "dillo", timeoutMs: 30_000 },
    });
    expect(configFromQuery(new URLSearchParams("jid=nope&password=x"), null)).toEqual({
      error: expect.stringContaining("JID"),
    });
    expect(configFromQuery(new URLSearchParams("jid=a@b&password="), null)).toEqual({
      error: expect.stringContaining("password"),
    });
    expect(configFromQuery(new URLSearchParams("jid=a@b&password=x&service=http://x"), null)).toEqual({
      error: expect.stringContaining("service"),
    });
  });

  it("serves the status page, saves through the form, and escapes what it echoes", async () => {
    const saved: DpiConfig[] = [];
    let reconnects = 0;
    let signedInAs: string | null = "alice@example.org/dillo";
    const deps = {
      state: async () => ({
        signedInAs,
        configPath: "/home/x/.dillo/httpx.json",
        config: saved.at(-1) ?? null,
        configError: saved.length === 0 ? 'Cannot read <file>' : null,
      }),
      save: async (config: DpiConfig) => {
        saved.push(config);
        signedInAs = null;
      },
      reconnect: async () => {
        reconnects += 1;
        signedInAs = null;
      },
    };

    const status = await handleLocal("dpi:/httpx/", deps);
    const statusHtml = await status.text();
    expect(status.status).toBe(200);
    expect(statusHtml).toContain("Signed in as <b>alice@example.org/dillo</b>");
    expect(statusHtml).toContain("Cannot read &lt;file&gt;");
    expect(statusHtml).not.toContain("<file>");

    const bad = await handleLocal("dpi:/httpx/save?jid=nope&password=x", deps);
    expect(bad.status).toBe(400);
    expect(saved).toHaveLength(0);

    const ok = await handleLocal(
      "dpi:/httpx/save?jid=bob%40example.org&password=s3cret&service=wss%3A%2F%2Fexample.org%2Fws&resource=dillo&timeoutMs=1000",
      deps,
    );
    const okHtml = await ok.text();
    expect(ok.status).toBe(200);
    expect(saved).toEqual([
      { jid: "bob@example.org", password: "s3cret", service: "wss://example.org/ws", resource: "dillo", timeoutMs: 1000 },
    ]);
    // The saved page shows the new JID but never the password.
    expect(okHtml).toContain('value="bob@example.org"');
    expect(okHtml).not.toContain("s3cret");
    expect(okHtml).toContain("Signed out.");

    const again = await handleLocal("dpi:/httpx/reconnect", deps);
    expect(again.status).toBe(200);
    expect(reconnects).toBe(1);

    expect((await handleLocal("dpi:/httpx/nope", deps)).status).toBe(404);
  });
});

describe("formatHead", () => {
  it("writes the status line Dillo's cache parses, with a reason phrase when the server sent none", () => {
    expect(formatHead(new Response(null, { status: 404 }))).toBe("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(formatHead(new Response(null, { status: 599, statusText: "Odd" }))).toBe(
      "HTTP/1.1 599 Odd\r\n\r\n",
    );
    const head = formatHead(
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/plain", "transfer-encoding": "chunked", connection: "close" },
      }),
    );
    expect(head).toBe("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n");
  });
});

describe("serveConnection", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /** A plugin listening on loopback, its fetch backed by the mock pair. */
  async function startPlugin(overrides: Partial<ServeOptions> = {}): Promise<{
    port: number;
    byes: number;
    server: HttpxServer;
  }> {
    const [clientSession, serverSession] = createSessionPair(
      "alice@example.org/dillo",
      "web@example.org",
    );
    const httpx = new HttpxServer(serverSession, { authorize: allowAll() });
    httpx.handle((req) => {
      if (req.resource === "/") {
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            connection: "close",
          },
          body: "<h1>hello from XEP-0332</h1>",
        };
      }
      if (req.resource === "/old") {
        return { status: 302, headers: { location: "/" } };
      }
      if (req.resource === "/empty") return { status: 204 };
      return { status: 404, headers: { "content-type": "text/plain" }, body: "no such page" };
    });
    httpx.start();

    const state = { port: 0, byes: 0, server: httpx };
    const options: ServeOptions = {
      fetch: (url) => httpxFetch(url, { session: clientSession }),
      checkAuth: (message) => message === SECRET,
      onBye: () => {
        state.byes += 1;
      },
      tagTimeoutMs: 2000,
      ...overrides,
    };
    const server = createServer((socket) => void serveConnection(socket, options));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    state.port = address.port;
    return state;
  }

  /** Speak like Dillo: connect, auth, command, collect everything to EOF. */
  async function talk(
    port: number,
    tags: string[],
    options: { authFirst?: boolean } = {},
  ): Promise<{ tag: Record<string, string> | null; payload: string; statuses: string[] }> {
    const socket: Socket = connect(port, "127.0.0.1");
    await new Promise<void>((r) => socket.once("connect", r));
    if (options.authFirst !== false) socket.write(buildTag({ cmd: "auth", msg: SECRET }));
    for (const tag of tags) socket.write(tag);
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    await new Promise<void>((r) => socket.once("close", r));
    const buffer = new TagBuffer(1 << 20);
    buffer.push(Buffer.concat(chunks));
    const statuses: string[] = [];
    let tag = buffer.nextTag();
    while (tag !== null && tag.cmd === "send_status_message") {
      statuses.push(tag.msg ?? "");
      tag = buffer.nextTag();
    }
    return { tag, payload: new TextDecoder().decode(buffer.rest()), statuses };
  }

  it("answers open_url with start_send_page and an HTTP response Dillo can parse", async () => {
    const { port } = await startPlugin();
    const { tag, payload } = await talk(port, [
      buildTag({ cmd: "open_url", url: "httpx://web@example.org/" }),
    ]);
    expect(tag).toEqual({ cmd: "start_send_page", url: "httpx://web@example.org/" });
    const [head, body] = payload.split("\r\n\r\n", 2);
    const lines = head?.split("\r\n") ?? [];
    expect(lines[0]).toBe("HTTP/1.1 200 OK");
    expect(lines).toContain("content-type: text/html; charset=utf-8");
    // Hop-by-hop headers describe the socket, not the resource.
    expect(lines.some((l) => l.startsWith("connection:"))).toBe(false);
    expect(body).toBe("<h1>hello from XEP-0332</h1>");
  });

  it("passes status codes, redirects and empty bodies through", async () => {
    const { port } = await startPlugin();
    const missing = await talk(port, [buildTag({ cmd: "open_url", url: "httpx://web@example.org/nope" })]);
    expect(missing.payload.startsWith("HTTP/1.1 404 Not Found\r\n")).toBe(true);
    expect(missing.payload.endsWith("\r\n\r\nno such page")).toBe(true);

    const moved = await talk(port, [buildTag({ cmd: "open_url", url: "httpx://web@example.org/old" })]);
    expect(moved.payload.startsWith("HTTP/1.1 302 Found\r\n")).toBe(true);
    expect(moved.payload).toContain("\r\nlocation: /\r\n");

    const empty = await talk(port, [buildTag({ cmd: "open_url", url: "httpx://web@example.org/empty" })]);
    expect(empty.payload.startsWith("HTTP/1.1 204 No Content\r\n")).toBe(true);
    expect(empty.payload.endsWith("\r\n\r\n")).toBe(true);
  });

  it("closes without a byte when the shared secret is wrong or missing", async () => {
    const { port } = await startPlugin();
    const wrong = await talk(
      port,
      [buildTag({ cmd: "auth", msg: "nope" }), buildTag({ cmd: "open_url", url: "httpx://web@example.org/" })],
      { authFirst: false },
    );
    expect(wrong.tag).toBeNull();
    expect(wrong.payload).toBe("");

    const none = await talk(port, [buildTag({ cmd: "open_url", url: "httpx://web@example.org/" })], {
      authFirst: false,
    });
    expect(none.tag).toBeNull();
    expect(none.payload).toBe("");
  });

  it("renders failures as pages: a refused JID, a non-httpx URL, a missing setup", async () => {
    const forbidden = await startPlugin({
      fetch: () => Promise.reject(new HttpxError("forbidden", "forbidden: <not you>")),
    });
    const refused = await talk(forbidden.port, [
      buildTag({ cmd: "open_url", url: "httpx://web@example.org/" }),
    ]);
    expect(refused.payload.startsWith("HTTP/1.1 403 Forbidden\r\n")).toBe(true);
    expect(refused.payload).toContain("content-type: text/html; charset=utf-8");
    expect(refused.payload).toContain("forbidden: &lt;not you&gt;");
    expect(refused.payload).not.toContain("<not you>");

    const { port } = await startPlugin();
    const notHttpx = await talk(port, [buildTag({ cmd: "open_url", url: "gopher://example.org/" })]);
    expect(notHttpx.tag).toEqual({ cmd: "start_send_page", url: "gopher://example.org/" });
    expect(notHttpx.payload.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
    expect(notHttpx.payload).toContain("Not an httpx address");

    const unconfigured = await startPlugin({
      fetch: (_url, context) => {
        context.status("httpx: signing in…");
        return Promise.reject(new DpiSetupError("Cannot read httpx.json", "Create it."));
      },
    });
    const setup = await talk(unconfigured.port, [
      buildTag({ cmd: "open_url", url: "httpx://web@example.org/" }),
    ]);
    expect(setup.statuses).toEqual(["httpx: signing in…"]);
    expect(setup.payload.startsWith("HTTP/1.1 503 Service Unavailable\r\n")).toBe(true);
    expect(setup.payload).toContain("<i>Create it.</i>");
  });

  it("treats DpiBye as the shutdown signal and ignores anything else", async () => {
    const state = await startPlugin();
    const bye = await talk(state.port, ["<cmd='DpiBye' '>"]);
    expect(bye.tag).toBeNull();
    expect(bye.payload).toBe("");
    expect(state.byes).toBe(1);

    const unknown = await talk(state.port, ["<cmd='dialog' msg='?' '>"]);
    expect(unknown.tag).toBeNull();
    expect(state.byes).toBe(1);
  });
});
