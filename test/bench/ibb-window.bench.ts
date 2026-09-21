import { bench, describe } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import {
  createSessionPair,
  type MockSession,
} from "../../src/testing/mock-session.js";

/**
 * IBB throughput as a function of block size — and, once the sender keeps
 * several blocks in flight, of window size. The companion to
 * test/e2e/transports.prosody.bench.ts, which measures the same path over a
 * real server but only at loopback latency.
 *
 * Latency is what IBB is actually bounded by: every block costs one IQ round
 * trip, so an unwindowed sender moves exactly one block per RTT regardless of
 * bandwidth. The `deliverHook` on the mock pair makes that visible — each
 * stanza is held for rtt/2, so a block's IQ result comes back one full RTT
 * after it was sent, and a 100 ms path is simulated without a network.
 *
 * Numbers here are *latency*-realistic, not bandwidth-realistic: base64,
 * XML framing and the receiver's copies all run at memory speed. That is the
 * right bias for this question — it isolates the round trips.
 *
 * Run: `npm run bench`. The 100 ms group is deliberately slow (the 4 KiB /
 * window 1 case needs one round trip per 4 KiB, so ~26 s for a single 1 MiB
 * sample); it runs one iteration per case for that reason.
 */

function body(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
  return bytes;
}

/**
 * Holds every stanza for rtt/2 before delivering it, in both directions, so
 * one IQ request+result pair costs a full `rttMs`. Node fires equal-delay
 * timers in insertion order, so stanza ordering — which IBB's seq check
 * depends on — is preserved.
 */
function delayedPair(rttMs: number): [MockSession, MockSession] {
  const pair = createSessionPair();
  if (rttMs > 0) {
    const hop = rttMs / 2;
    for (const session of pair) {
      session.deliverHook = (_stanza, deliver) => {
        setTimeout(deliver, hop);
      };
    }
  }
  return pair;
}

interface Case {
  /** Decoded bytes per IBB block; advertised to the server as maxChunkSize. */
  blockSize: number;
  /** Blocks the server keeps in flight. 1 is the pre-window sender. */
  window: number;
}

function harness(size: number, rttMs: number, options: Case) {
  const [clientSession, serverSession] = delayedPair(rttMs);
  const payload = body(size);

  const server = new HttpxServer(serverSession, {
    authorize: allowAll(),
    preferredStreams: ["ibb"],
    compress: false,
    ibbWindow: options.window,
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
    maxChunkSize: options.blockSize,
    // The receiving half of the window: how far ahead the response body may
    // run before this client starts withholding acks.
    ibbWindow: options.window,
    maxBufferedBytes: 32 * 1024 * 1024,
    // The 4 KiB / window 1 case at 100 ms RTT spends ~26 s on one body; the
    // idle timeout bounds the gap *between* blocks, not the whole transfer,
    // but the request IQ itself must outlive the transfer.
    defaultTimeoutMs: 600_000,
    idleTimeoutMs: 120_000,
  });

  return {
    async roundtrip() {
      const resp = await client.request("server@example.org", {
        resource: "/bench",
      });
      const received = await bytesFromStream(resp.body!);
      if (resp.statusCode !== 200 || received.byteLength !== size) {
        throw new Error(
          `bench integrity: HTTP ${resp.statusCode}, ${received.byteLength} of ` +
            `${size} bytes — a truncated body must not count as a (fast) sample`,
        );
      }
    },
    async close() {
      await client.close();
      server.stop();
    },
  };
}

function label(size: number): string {
  return size >= 1024 * 1024
    ? `${size / 1024 / 1024} MiB`
    : `${size / 1024} KiB`;
}

function run(
  name: string,
  size: number,
  rttMs: number,
  options: Case,
  iterations: number,
): void {
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
          // (tinybench rethrows before its error event fires and vitest's
          // wrapper loses the rejection) — see test/bench/s5b.bench.ts.
          console.error(`[bench:ibb] ${name}: ${String(err)}`);
          process.exit(1);
        }
        throw err; // warmup throws surface loudly through vitest
      }
    },
    {
      iterations,
      warmupIterations: 1,
      time: 0,
      warmupTime: 0,
      // Without this a *warmup* error is swallowed into task.result.error and
      // the case silently vanishes from the table with a zero exit code.
      throws: true,
      setup: (_task, mode) => {
        phase = mode;
        h = harness(size, rttMs, options);
      },
      teardown: async () => {
        await h.close();
      },
    },
  );
}

// ---------------------------------------------------------- loopback (RTT 0)

for (const size of [1024 * 1024, 8 * 1024 * 1024]) {
  describe(`IBB response body, no added latency — ${label(size)}`, () => {
    run("block 4 KiB, window 1", size, 0, { blockSize: 4096, window: 1 }, 10);
    run("block 4 KiB, window 8", size, 0, { blockSize: 4096, window: 8 }, 10);
    run("block 64 KiB, window 1", size, 0, { blockSize: 65536, window: 1 }, 10);
    run("block 64 KiB, window 8", size, 0, { blockSize: 65536, window: 8 }, 10);
  });
}

// ------------------------------------------------------- simulated 100 ms RTT

describe("IBB response body, 100 ms simulated RTT — 1 MiB", () => {
  // Same body for every case, so hz compares directly. The first is the
  // pre-window sender: one round trip per 4 KiB block, 256 blocks, ~26 s for
  // a single sample — which is the number the rest is measured against.
  run("block 4 KiB, window 1", 1024 * 1024, 100, { blockSize: 4096, window: 1 }, 1);
  run("block 64 KiB, window 1", 1024 * 1024, 100, { blockSize: 65536, window: 1 }, 1);
  run("block 64 KiB, window 8", 1024 * 1024, 100, { blockSize: 65536, window: 8 }, 3);
  run("block 64 KiB, window 16", 1024 * 1024, 100, { blockSize: 65536, window: 16 }, 3);
});

// A body large enough that the transfer, not the three fixed round trips
// (request, <open>, <close>), decides the number. No window-1 counterpart:
// that sender would need ~3.5 minutes per sample here.
describe("IBB response body, 100 ms simulated RTT — 8 MiB (windowed only)", () => {
  run("block 64 KiB, window 8", 8 * 1024 * 1024, 100, { blockSize: 65536, window: 8 }, 1);
  run("block 64 KiB, window 16", 8 * 1024 * 1024, 100, { blockSize: 65536, window: 16 }, 1);
});
