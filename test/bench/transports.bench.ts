import { bench, describe } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import type { StreamMechanism } from "../../src/transport/select.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { createSessionPair } from "../integration/mock-session.js";

/**
 * Throughput of each transport over the in-memory session pair (no network,
 * no compression — pure codec + framing cost). Comparative, not absolute:
 * the mock delivers on microtasks, so numbers are a lower bound on framing
 * overhead per mechanism, useful for tuning chunk/block sizes and spotting
 * regressions. Run: `npm run bench`.
 */

function body(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
  return bytes;
}

function harness(preferred: StreamMechanism[], size: number) {
  const [clientSession, serverSession] = createSessionPair();
  const payload = body(size);
  const server = new HttpxServer(serverSession, {
    authorize: allowAll(),
    preferredStreams: preferred,
    compress: false,
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
    maxBufferedBytes: 16 * 1024 * 1024,
  });
  return {
    async roundtrip() {
      const resp = await client.request("server@example.org", { resource: "/b" });
      await bytesFromStream(resp.body!);
    },
    async close() {
      await client.close();
      server.stop();
    },
  };
}

for (const size of [64 * 1024, 1024 * 1024]) {
  const label = size >= 1024 * 1024 ? `${size / 1024 / 1024} MiB` : `${size / 1024} KiB`;
  describe(`response body — ${label}`, () => {
    const cases: Array<[string, StreamMechanism[]]> = [
      ["base64 (inline path)", ["chunkedBase64"]], // small sizes inline; large stream
      ["chunkedBase64", ["chunkedBase64"]],
      ["ibb", ["ibb"]],
      ["sipub", ["sipub"]],
      ["jingle", ["jingle"]],
    ];
    for (const [name, preferred] of cases) {
      let h: ReturnType<typeof harness>;
      bench(
        name,
        async () => {
          await h.roundtrip();
        },
        {
          time: 500,
          setup: () => {
            h = harness(preferred, size);
          },
          teardown: async () => {
            await h.close();
          },
        },
      );
    }
  });
}
