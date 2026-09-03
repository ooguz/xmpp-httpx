import { bench, describe } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { createSocks5Adapter } from "../../src/node/socks5.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import type { Socks5Adapter } from "../../src/socks5/protocol.js";
import type { StreamMechanism } from "../../src/transport/select.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { COMPONENT_DOMAIN, connectComponent, connectUser } from "./e2e-env.js";

/**
 * Wire-clocked throughput over a real Prosody: an @xmpp/client user fetches
 * from an @xmpp/component gateway, every stanza crossing the server — the
 * measurement the mock-pair benches (test/bench/) explicitly cannot provide.
 * Run: `npm run bench:prosody` (Docker; the e2e globalSetup owns Prosody and
 * takes it down afterwards — `npm run demo` brings it back).
 *
 * What the wire changes: IBB pays a full client↔server↔component round trip
 * per 4 KiB block, chunked messages cross the server once but uncounted, and
 * the S5B paths pay negotiation IQs through the server, then move the body
 * over a direct TCP connection that bypasses Prosody entirely — which is
 * XEP-0065's whole point, so the bypass is the honest measurement, not a
 * cheat. (Both endpoints live on this host, so "the wire" is loopback:
 * numbers are comparative, free of the mock pair's microtask optimism.)
 *
 * Plumbing constraints this file works around:
 *  - one component connection per domain, and tinybench never awaits its
 *    async teardown hook — so each case connects lazily inside its first
 *    (warmup) iteration, after awaiting the previous case's drain promise;
 *  - a stopped HttpxServer's iq handler stays registered on its session and
 *    would shadow a successor's — hence fresh sessions per case, never a
 *    shared one;
 *  - every S5B round trip asserts, inside the measured function (with
 *    throws: true — the lessons of test/bench/s5b.bench.ts), that it opened
 *    a negotiated socket rather than quietly falling back to IBB.
 */

function body(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
  return bytes;
}

/** The previous case's connections, still going down. */
let drain: Promise<void> = Promise.resolve();
let resourceSeq = 0;

interface Live {
  client: HttpxClient;
  close: () => Promise<void>;
}

function harness(preferred: StreamMechanism[], size: number, s5b: boolean) {
  const payload = body(size);
  let opened = 0;
  let roundtrips = 0;
  let ready: Promise<Live> | null = null;

  const init = async (): Promise<Live> => {
    await drain;
    const componentConn = await connectComponent();
    const userConn = await connectUser("alice", "e2e-alice", `bench-${resourceSeq++}`);

    let serverSocks5: Socks5Adapter | undefined;
    let clientSocks5: Socks5Adapter | undefined;
    if (s5b) {
      const real = createSocks5Adapter(componentConn.session, {
        listen: { host: "127.0.0.1", port: 0 },
      });
      serverSocks5 = {
        ...real,
        openChosen: (...args) => {
          opened += 1;
          return real.openChosen(...args);
        },
      };
      clientSocks5 = createSocks5Adapter(userConn.session, {});
    }

    const server = new HttpxServer(componentConn.session, {
      authorize: allowAll(),
      preferredStreams: preferred,
      compress: false,
      ...(serverSocks5 ? { socks5: serverSocks5 } : {}),
    });
    server.handle(() => ({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    }));
    server.start();

    const client = new HttpxClient(userConn.session, {
      discover: false,
      compress: false,
      maxBufferedBytes: 32 * 1024 * 1024,
      defaultTimeoutMs: 120_000,
    ...(clientSocks5 ? { socks5: clientSocks5 } : {}),
    });

    return {
      client,
      close: async () => {
        await client.close();
        server.stop();
        serverSocks5?.release();
        clientSocks5?.release();
        await userConn.stop();
        await componentConn.stop();
      },
    };
  };

  return {
    async roundtrip() {
      ready ??= init(); // first (warmup) iteration pays the connection cost
      const { client } = await ready;
      roundtrips += 1;
      const resp = await client.request(COMPONENT_DOMAIN, { resource: "/bench" });
      const received = await bytesFromStream(resp.body!);
      if (resp.statusCode !== 200 || received.byteLength !== size) {
        throw new Error(
          `bench integrity: HTTP ${resp.statusCode}, ${received.byteLength} of ` +
            `${size} bytes — a truncated body must not count as a (fast) sample`,
        );
      }
      if (s5b && opened !== roundtrips) {
        throw new Error(
          `s5b bench integrity: round trip ${roundtrips} delivered its body with ` +
            `${opened} negotiated sockets — it travelled over IBB through the ` +
            "server, and publishing that as an S5B number would be a lie",
        );
      }
    },
    // Called by tinybench without an await: hand the async close to the next
    // case through `drain` so its lazy init waits for these connections to be
    // fully gone before binding the (single-connection) component domain.
    teardown() {
      const live = ready;
      drain = (async () => {
        const l = await live;
        if (l) await l.close();
      })();
    },
  };
}

for (const size of [64 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
  const label =
    size >= 1024 * 1024 ? `${size / 1024 / 1024} MiB` : `${size / 1024} KiB`;
  describe(`response body over Prosody — ${label}`, () => {
    const cases: Array<[string, StreamMechanism[], boolean]> = [
      ["chunkedBase64 (via server)", ["chunkedBase64"], false],
      ["ibb (via server)", ["ibb"], false],
      ["sipub + socks5 (direct TCP)", ["sipub"], true],
      ["jingle + socks5 (direct TCP)", ["jingle"], true],
    ];
    for (const [name, preferred, s5b] of cases) {
      let h: ReturnType<typeof harness> | undefined;
      let phase: "warmup" | "run" = "warmup";
      bench(
        name,
        async () => {
          try {
            await h!.roundtrip();
          } catch (err) {
            if (phase === "run") {
              // A run-phase throw under throws:true would leave vitest
              // awaiting a promise that never settles — tinybench rethrows
              // before dispatching its error event, and vitest's setTimeout
              // wrapper loses the rejection: a silent, indefinite hang.
              // Crash the worker instead: loud, non-zero, reason printed.
              console.error(`[bench:prosody] ${name} (${label}): ${String(err)}`);
              process.exit(1);
            }
            throw err; // warmup throws surface loudly through vitest
          }
        },
        {
          time: 500,
          // Without this, tinybench swallows a *warmup* error into
          // task.result.error and the case silently vanishes (run exits 0);
          // run-phase errors never reach it — see the catch above.
          throws: true,
          // Mode-aware on purpose: vitest invokes both hooks around the
          // warmup phase AND the run phase. Creating the harness once lets
          // the warmup iterations pay the connection cost so every measured
          // sample rides a warm connection; tearing down only after 'run'
          // keeps that connection alive between the phases.
          setup: (_task, mode) => {
            phase = mode;
            h ??= harness(preferred, size, s5b);
          },
          teardown: (_task, mode) => {
            if (mode === "run") h!.teardown();
          },
        },
      );
    }
  });
}
