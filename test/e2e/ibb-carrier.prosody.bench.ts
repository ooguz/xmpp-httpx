import xml from "@xmpp/xml";
import { bench, describe } from "vitest";
import { NS_IBB } from "../../src/constants.js";
import { IbbManager } from "../../src/ibb/ibb.js";
import { encodeBase64 } from "../../src/util/base64.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { COMPONENT_DOMAIN, connectComponent, connectUser } from "./e2e-env.js";

/**
 * IBB over IQ versus IBB over <message>, through a real Prosody: the open
 * question in n146's design (§9) for its stealth tunnels.
 *
 * - **iq**: the library's sender. Every <data> is an IQ the receiver answers,
 *   with `window` blocks in flight; the answer is the flow control.
 * - **message**: XEP-0047 §2.2's other carrier, unacknowledged. The library
 *   only ever sends IQ, so this file sends the <message> blocks itself; the
 *   receiver is the library's own, which accepts message-carried <data> on an
 *   open session. Nothing slows the sender down: every block is written as
 *   fast as the socket takes it.
 *
 * Direction: component → server → client account, the way an exit sends a
 * download to the daemon. Run: `npm run bench:prosody` (Docker), or this file
 * alone with `E2E=1 npx vitest bench --project e2e --run <file>`.
 *
 * Every sample checks, inside the measured function, that all bytes arrived:
 * an unacknowledged carrier that loses blocks must fail, not look fast.
 */

const SIZE = 8 * 1024 * 1024;
const payload = new Uint8Array(SIZE).map((_, i) => (i * 31 + 7) & 0xff);

let drain: Promise<void> = Promise.resolve();
let resourceSeq = 0;
let sidSeq = 0;

interface Live {
  send: (sid: string) => Promise<void>;
  receive: (sid: string) => Promise<number>;
  close: () => Promise<void>;
}

function harness(carrier: "iq" | "message", blockSize: number) {
  let ready: Promise<Live> | null = null;

  const init = async (): Promise<Live> => {
    await drain;
    const exit = await connectComponent();
    const user = await connectUser("alice", "e2e-alice", `carrier-${resourceSeq++}`);
    const sender = IbbManager.acquire(exit.session);
    const receiver = IbbManager.acquire(user.session);
    const to = user.jid;

    const viaIq = async (sid: string): Promise<void> => {
      const out = await sender.openOutgoing(to, { sid, blockSize, from: COMPONENT_DOMAIN });
      for (let o = 0; o < SIZE; o += 256 * 1024) await out.write(payload.subarray(o, o + 256 * 1024));
      await out.close();
    };

    const viaMessage = async (sid: string): Promise<void> => {
      const iq = (child: ReturnType<typeof xml>) =>
        exit.session.iqCaller.request(xml("iq", { type: "set", to, from: COMPONENT_DOMAIN }, child), 60_000);
      await iq(xml("open", { xmlns: NS_IBB, sid, "block-size": String(blockSize), stanza: "message" }));
      let seq = 0;
      for (let o = 0; o < SIZE; o += blockSize) {
        await exit.session.send(
          xml(
            "message",
            { to, from: COMPONENT_DOMAIN },
            xml("data", { xmlns: NS_IBB, sid, seq: String(seq) }, encodeBase64(payload.subarray(o, o + blockSize))),
          ),
        );
        seq = (seq + 1) % 65536;
      }
      // The close travels the same ordered streams, so it lands after the data.
      await iq(xml("close", { xmlns: NS_IBB, sid }));
    };

    return {
      send: carrier === "iq" ? viaIq : viaMessage,
      receive: async (sid) => {
        const incoming = await receiver.expectIncoming(COMPONENT_DOMAIN, sid, { timeoutMs: 60_000 });
        return (await bytesFromStream(incoming.readable)).byteLength;
      },
      close: async () => {
        await user.stop();
        await exit.stop();
      },
    };
  };

  return {
    async transfer() {
      ready ??= init();
      const live = await ready;
      const sid = `carrier-${sidSeq++}`;
      const receiving = live.receive(sid); // registered before the <open> leaves
      await live.send(sid);
      const received = await receiving;
      if (received !== SIZE) {
        throw new Error(`${carrier} carrier lost data: ${received} of ${SIZE} bytes arrived`);
      }
    },
    teardown() {
      const live = ready;
      drain = (async () => {
        const l = await live;
        if (l) await l.close();
      })();
    },
  };
}

describe("IBB carrier, 8 MiB exit → client over Prosody", () => {
  for (const blockSize of [4096, 32768]) {
    for (const carrier of ["iq", "message"] as const) {
      const name = `${carrier}, ${blockSize / 1024} KiB blocks`;
      let h: ReturnType<typeof harness> | undefined;
      let phase: "warmup" | "run" = "warmup";
      bench(
        name,
        async () => {
          try {
            await h!.transfer();
          } catch (err) {
            // As in transports.prosody.bench.ts: a run-phase throw under
            // throws:true hangs vitest silently, so crash loudly instead.
            if (phase === "run") {
              console.error(`[bench:carrier] ${name}: ${String(err)}`);
              process.exit(1);
            }
            throw err;
          }
        },
        {
          iterations: 5,
          warmupIterations: 1,
          throws: true,
          // vitest runs both hooks around warmup AND run: keep the warm
          // connection between them and tear down after the run only.
          setup: (_task, mode) => {
            phase = mode;
            h ??= harness(carrier, blockSize);
          },
          teardown: (_task, mode) => {
            if (mode === "run") h!.teardown();
          },
        },
      );
    }
  }
});
