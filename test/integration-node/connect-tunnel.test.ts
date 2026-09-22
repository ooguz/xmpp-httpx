import net from "node:net";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer, type HttpxHandler } from "../../src/server/server.js";
import { createSessionPair } from "../../src/testing/mock-session.js";
import { concatBytes } from "../../src/util/bytes.js";

/**
 * The README's tunnel example, verbatim in substance, against a real TCP
 * destination: if this breaks, so does the first thing anyone copies.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

/** The README handler. */
const readmeHandler: HttpxHandler = async (req) => {
  if (req.method !== "CONNECT") return { status: 405 };
  const colon = req.resource.lastIndexOf(":"); // authority-form: host:port, IPv6 in brackets
  const host = req.resource.slice(0, colon).replace(/^\[(.*)\]$/, "$1");
  const socket = net.connect(Number(req.resource.slice(colon + 1)), host);
  try {
    await once(socket, "connect");
  } catch {
    return { status: 502 };
  }
  return {
    status: 200,
    tunnel: async (tunnel) => {
      // The destination may have hung up while the <open> was on its way.
      if (socket.destroyed) return tunnel.close().catch(() => {});
      socket.on("close", () => void tunnel.close().catch(() => {}));
      socket.on("data", (chunk: Buffer) => {
        socket.pause(); // write() resolves when the window has room
        tunnel.write(chunk).then(() => socket.resume(), () => socket.destroy());
      });
      try {
        await pipeline(tunnel.readable, socket); // waits for 'drain' the other way
      } finally {
        socket.destroy();
      }
    },
  };
};

async function listen(
  onSocket: (socket: net.Socket) => void,
  host = "127.0.0.1",
): Promise<number> {
  const accepted = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    accepted.add(socket);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        // close() waits for open connections; a destination that never
        // reads never lets its socket finish on its own.
        for (const socket of accepted) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

function setup() {
  const [clientSession, serverSession] = createSessionPair();
  const exit = new HttpxServer(serverSession, { authorize: allowAll(), tunnels: true });
  exit.handle(readmeHandler);
  exit.start();
  const client = new HttpxClient(clientSession);
  cleanups.push(async () => {
    await client.close();
    exit.stop();
  });
  return client;
}

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13 + 1) & 0xff;
  return bytes;
}

describe("the README tunnel, against a real TCP destination", () => {
  it("echoes bytes through the tunnel and back, then closes from the destination", async () => {
    const port = await listen((socket) => {
      // An echo server that hangs up once it has echoed 200 kB.
      let seen = 0;
      socket.on("data", (chunk) => {
        seen += chunk.length;
        socket.write(chunk);
        if (seen >= 200_000) socket.end();
      });
    });
    const client = setup();
    const { response, tunnel } = await client.connect("server@example.org", {
      authority: `127.0.0.1:${port}`,
    });
    expect(response.statusCode).toBe(200);

    const up = pattern(200_000);
    const reading = (async () => {
      const parts: Uint8Array[] = [];
      for await (const chunk of tunnel!.readable) parts.push(chunk);
      return concatBytes(parts);
    })();
    for (let o = 0; o < up.length; o += 16_384) await tunnel!.write(up.subarray(o, o + 16_384));
    // The destination closing is what ends the tunnel: the reader sees EOF.
    expect(await reading).toEqual(up);
  });

  it("answers 502 when the destination refuses the connection", async () => {
    // A port nothing listens on: grab one, then close it.
    const closed = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const client = setup();
    const { response, tunnel } = await client.connect("server@example.org", {
      authority: `127.0.0.1:${closed}`,
    });
    expect(response.statusCode).toBe(502);
    expect(tunnel).toBeNull();
  });

  it("reaches an IPv6 destination named in brackets", async () => {
    const port = await listen((socket) => socket.end("hi"), "::1");
    const client = setup();
    const { response, tunnel } = await client.connect("server@example.org", {
      authority: `[::1]:${port}`,
    });
    expect(response.statusCode).toBe(200);
    const parts: Uint8Array[] = [];
    for await (const chunk of tunnel!.readable) parts.push(chunk);
    expect(new TextDecoder().decode(concatBytes(parts))).toBe("hi");
  });

  it("ends the tunnel when the destination hangs up before the <open> lands", async () => {
    const port = await listen((socket) => socket.destroy());
    const client = setup();
    const { response, tunnel } = await client.connect("server@example.org", {
      authority: `127.0.0.1:${port}`,
    });
    expect(response.statusCode).toBe(200);
    const ended = (async () => {
      for await (const _ of tunnel!.readable) void _;
      return "eof";
    })();
    const outcome = await Promise.race([
      ended,
      new Promise((r) => setTimeout(() => r("hung"), 2_000)),
    ]);
    expect(outcome).toBe("eof");
  });

  it("a destination that stops reading stops the client, not the exit's memory", async () => {
    const port = await listen((socket) => socket.pause());
    const client = setup();
    const { tunnel } = await client.connect("server@example.org", {
      authority: `127.0.0.1:${port}`,
    });
    const chunk = new Uint8Array(64 * 1024);
    let written = 0;
    const deadline = Date.now() + 1_500;
    const writing = (async () => {
      while (Date.now() < deadline && written < 64 * 1024 * 1024) {
        await tunnel!.write(chunk);
        written += chunk.length;
      }
    })();
    await Promise.race([writing, new Promise((r) => setTimeout(r, 1_600))]);
    // Kernel socket buffers plus the IBB window, not the whole upload: the
    // exit waits for 'drain' before it takes more from the tunnel.
    expect(written).toBeLessThan(24 * 1024 * 1024);
    await tunnel!.abort(new Error("done"));
  });
});
