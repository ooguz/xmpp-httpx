import { bench, describe } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { createSocks5Adapter } from "../../src/node/socks5.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import type { Socks5Adapter } from "../../src/socks5/protocol.js";
import type { StreamMechanism } from "../../src/transport/select.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

/**
 * SOCKS5 Bytestreams throughput — the sipub (XEP-0065) and Jingle (XEP-0260)
 * paths against an IBB baseline. Signalling rides the same in-memory session
 * pair as transports.bench.ts, but the S5B bodies cross a *real* loopback TCP
 * socket (the server self-hosts a direct streamhost, the client dials it), so
 * each S5B round trip pays genuine per-request costs — TCP connect, SOCKS5
 * handshake, negotiation IQs — and then streams raw bytes with no base64 or
 * stanza framing.
 *
 * The comparison is deliberately biased *against* S5B: the IBB baseline's
 * stanzas are delivered on microtasks and never touch a socket, while the S5B
 * paths pay for a real one. Where S5B still wins, the win understates what a
 * real wire would show. Absolute numbers are not wire-clocked (loopback, no
 * Prosody); the point is the fixed-cost-vs-per-byte-cost crossover.
 *
 * Every S5B round trip asserts, before it counts, that it actually opened a
 * negotiated socket — a silent fallback to IBB would otherwise publish IBB
 * numbers under an S5B label. The check lives inside the measured function
 * on purpose: tinybench does not await the async teardown hook, so a throw
 * there surfaces only as a detached unhandled rejection while the case still
 * renders as passed, numbers and all. A throw inside the function is the one
 * place that reliably errors the benchmark task itself.
 */

function body(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
  return bytes;
}

function harness(preferred: StreamMechanism[], size: number, s5b: boolean) {
  const [clientSession, serverSession] = createSessionPair();
  const payload = body(size);
  let opened = 0;
  let roundtrips = 0;

  let serverSocks5: Socks5Adapter | undefined;
  let clientSocks5: Socks5Adapter | undefined;
  if (s5b) {
    const real = createSocks5Adapter(serverSession, {
      listen: { host: "127.0.0.1", port: 0 },
    });
    // Count negotiated sockets so the teardown guard can prove no round trip
    // quietly fell back to IBB (which would still deliver correct bytes).
    serverSocks5 = {
      ...real,
      openChosen: (...args) => {
        opened += 1;
        return real.openChosen(...args);
      },
    };
    clientSocks5 = createSocks5Adapter(clientSession, {});
  }

  const server = new HttpxServer(serverSession, {
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
  const client = new HttpxClient(clientSession, {
    discover: false,
    compress: false,
    maxBufferedBytes: 32 * 1024 * 1024,
    ...(clientSocks5 ? { socks5: clientSocks5 } : {}),
  });

  return {
    async roundtrip() {
      roundtrips += 1;
      const resp = await client.request("server@example.org", { resource: "/b" });
      const received = await bytesFromStream(resp.body!);
      if (resp.statusCode !== 200 || received.byteLength !== size) {
        throw new Error(
          `bench integrity: HTTP ${resp.statusCode}, ${received.byteLength} of ` +
            `${size} bytes — a truncated body must not count as a (fast) sample`,
        );
      }
      // The server opens the negotiated socket before it can write the body,
      // so by the time the body has been read in full the count must match.
      if (s5b && opened !== roundtrips) {
        throw new Error(
          `s5b bench integrity: round trip ${roundtrips} delivered its body with ` +
            `${opened} negotiated sockets — it travelled over IBB, and publishing ` +
            "that as an S5B number would be a lie",
        );
      }
    },
    async close() {
      await client.close();
      server.stop();
      serverSocks5?.release();
      clientSocks5?.release();
    },
  };
}

for (const size of [64 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
  const label =
    size >= 1024 * 1024 ? `${size / 1024 / 1024} MiB` : `${size / 1024} KiB`;
  describe(`response body over S5B — ${label}`, () => {
    const cases: Array<[string, StreamMechanism[], boolean]> = [
      ["ibb (in-memory pair)", ["ibb"], false],
      ["sipub + socks5 (real TCP)", ["sipub"], true],
      ["jingle + socks5 (real TCP)", ["jingle"], true],
    ];
    for (const [name, preferred, s5b] of cases) {
      let h: ReturnType<typeof harness>;
      let phase: "warmup" | "run" = "warmup";
      bench(
        name,
        async () => {
          try {
            await h.roundtrip();
          } catch (err) {
            if (phase === "run") {
              // Under throws:true a run-phase throw hangs vitest silently
              // (tinybench rethrows before its error event fires; vitest's
              // wrapper loses the rejection). Crash the worker instead.
              console.error(`[bench:s5b] ${name}: ${String(err)}`);
              process.exit(1);
            }
            throw err; // warmup throws surface loudly through vitest
          }
        },
        {
          time: 500,
          // Without this, tinybench swallows a *warmup* error into
          // task.result.error: the case just vanishes from the table and the
          // run exits 0 — the integrity guard would be silent. Run-phase
          // errors never reach it — see the catch above.
          throws: true,
          setup: (_task, mode) => {
            phase = mode;
            h = harness(preferred, size, s5b);
          },
          teardown: async () => {
            await h.close();
          },
        },
      );
    }
  });
}
