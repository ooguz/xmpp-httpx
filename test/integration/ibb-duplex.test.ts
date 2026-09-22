import xml, { type Element } from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { encodeReq } from "../../src/codec/req.js";
import { decodeResp, encodeResp } from "../../src/codec/resp.js";
import { NS_HTTPX, NS_IBB, NS_STANZAS } from "../../src/constants.js";
import { HttpxError } from "../../src/errors.js";
import { IbbManager, type IbbDuplex } from "../../src/ibb/ibb.js";
import { allowAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  type HttpxHandler,
  type HttpxServerOptions,
  type HttpxTunnel,
} from "../../src/server/server.js";
import { createSessionPair, type MockSession } from "../../src/testing/mock-session.js";
import { concatBytes } from "../../src/util/bytes.js";

/**
 * One IBB session carrying bytes both ways (design §4.2): the opener's sid,
 * used in both directions with independent seq counters, no half-close, and
 * the idle watchdog off for tunnels while bodies keep theirs.
 *
 * Both directions are always read at once. A duplex whose halves only work
 * one at a time passes any test that writes first and reads afterwards.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function payload(size: number, salt = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + salt) & 0xff;
  return bytes;
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Writes `bytes` in `step`-sized pieces, awaiting each (backpressure). */
async function writeAll(
  stream: { write(bytes: Uint8Array): Promise<void> },
  bytes: Uint8Array,
  step = 1000,
): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += step) {
    await stream.write(bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  }
}

/**
 * Reads exactly `n` bytes and keeps the reader. There is no half-close, so a
 * side must not close until it has everything the other side sent — which
 * only the application can know; this is the test's application.
 */
async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < n) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended after ${total} of ${n} bytes`);
    parts.push(value);
    total += value.length;
  }
  return concatBytes(parts);
}

interface WireEvent {
  /** "a>b" is opener → acceptor. */
  dir: "a>b" | "b>a";
  kind: "open" | "data" | "close";
  sid: string;
  seq?: number;
}

/** Records every IBB request on the wire, both directions, in send order. */
function tapIbb(a: MockSession, b: MockSession, wire: WireEvent[]): void {
  const tap = (dir: WireEvent["dir"]) => (stanza: Element, deliver: () => void) => {
    if (stanza.attrs["type"] === "set") {
      for (const kind of ["open", "data", "close"] as const) {
        const el = stanza.getChild(kind, NS_IBB);
        if (!el) continue;
        wire.push({
          dir,
          kind,
          sid: el.attrs["sid"] ?? "",
          ...(kind === "data" ? { seq: Number(el.attrs["seq"]) } : {}),
        });
      }
    }
    queueMicrotask(deliver);
  };
  a.deliverHook = tap("a>b");
  b.deliverHook = tap("b>a");
}

interface Pair {
  opener: IbbManager;
  acceptor: IbbManager;
  wire: WireEvent[];
}

const OPENER = "opener@example.org/x";
const ACCEPTOR = "acceptor@example.org/y";

function pair(options?: { receiveWindowBlocks?: number }): Pair {
  const [a, b] = createSessionPair(OPENER, ACCEPTOR);
  const wire: WireEvent[] = [];
  tapIbb(a, b, wire);
  const opener = IbbManager.acquire(a);
  const acceptor = IbbManager.acquire(b);
  if (options?.receiveWindowBlocks !== undefined) {
    opener.receiveWindowBlocks = options.receiveWindowBlocks;
    acceptor.receiveWindowBlocks = options.receiveWindowBlocks;
  }
  cleanups.push(() => {
    opener.release();
    acceptor.release();
  });
  return { opener, acceptor, wire };
}

async function openPair(
  p: Pair,
  options?: {
    blockSize?: number;
    window?: number;
    openerIdle?: number | false;
    acceptorIdle?: number | false;
  },
): Promise<{ a: IbbDuplex; b: IbbDuplex }> {
  const accepting = p.acceptor.expectDuplex(OPENER, "t", {
    ...(options?.window !== undefined ? { window: options.window } : {}),
    ...(options?.acceptorIdle !== undefined
      ? { idleTimeoutMs: options.acceptorIdle }
      : {}),
  });
  const a = await p.opener.openDuplex(ACCEPTOR, {
    sid: "t",
    blockSize: options?.blockSize ?? 512,
    ...(options?.window !== undefined ? { window: options.window } : {}),
    ...(options?.openerIdle !== undefined ? { idleTimeoutMs: options.openerIdle } : {}),
  });
  const b = await accepting;
  return { a, b };
}

/** How a reader ends: "eof", or the error it failed with. */
async function ending(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return "eof";
    }
  } catch (err) {
    return err;
  }
}

describe("duplex IBB: both directions", () => {
  it("carries bytes both ways at the same time, byte for byte", async () => {
    // Receive windows of 2 blocks make each sender park on acks the other
    // side's reader releases, so neither direction can complete before the
    // other has started — concurrency by construction, proved by the wire.
    const p = pair({ receiveWindowBlocks: 2 });
    const { a, b } = await openPair(p, { blockSize: 512, window: 4 });
    // Deliberately not block multiples, and written in 1000-byte pieces: each
    // write's tail must go out without waiting for a close().
    const aToB = payload(512 * 64 + 17, 1);
    const bToA = payload(512 * 48 + 3, 2);
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();

    const [, , atB, atA] = await Promise.all([
      writeAll(a, aToB),
      writeAll(b, bToA),
      readExactly(readerB, aToB.length),
      readExactly(readerA, bToA.length),
    ]);
    expect(atB).toEqual(aToB);
    expect(atA).toEqual(bToA);

    const data = p.wire.filter((e) => e.kind === "data");
    const firstAB = data.findIndex((e) => e.dir === "a>b");
    const lastAB = data.map((e) => e.dir).lastIndexOf("a>b");
    const between = data.slice(firstAB, lastAB).filter((e) => e.dir === "b>a");
    // Not merely both directions eventually: b→a blocks went out while a→b
    // was still in progress.
    expect(between.length).toBeGreaterThan(10);

    await a.close();
    expect(await ending(readerB)).toBe("eof");
    expect(await ending(readerA)).toBe("eof");
  });

  it("uses the opener's one sid both ways, with a seq counter per direction", async () => {
    const p = pair();
    const { a, b } = await openPair(p, { blockSize: 256 });
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();
    await Promise.all([
      writeAll(a, payload(256 * 5), 256),
      writeAll(b, payload(256 * 3), 256),
      readExactly(readerB, 256 * 5),
      readExactly(readerA, 256 * 3),
    ]);
    await b.close();

    // One <open>, from the opener. The acceptor adopted the sid instead of
    // opening its own — (a) of the task: there was no way to do that before.
    expect(p.wire.filter((e) => e.kind === "open")).toEqual([
      { dir: "a>b", kind: "open", sid: "t" },
    ]);
    expect(new Set(p.wire.map((e) => e.sid))).toEqual(new Set(["t"]));
    const seqs = (dir: WireEvent["dir"]) =>
      p.wire.filter((e) => e.kind === "data" && e.dir === dir).map((e) => e.seq);
    expect(seqs("a>b")).toEqual([0, 1, 2, 3, 4]);
    expect(seqs("b>a")).toEqual([0, 1, 2]);
  });

  it("a sub-block write goes out at once: request/answer works over a tunnel", async () => {
    // A body's sender holds a sub-block tail until close(). A tunnel cannot:
    // a TLS ClientHello is a few hundred bytes and nothing else is written
    // until the ServerHello comes back — held, it deadlocks the handshake.
    const p = pair();
    const { a, b } = await openPair(p, { blockSize: 4096 });
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();
    for (let round = 0; round < 3; round++) {
      await a.write(payload(517, round));
      expect(await readExactly(readerB, 517)).toEqual(payload(517, round));
      await b.write(payload(90, round));
      expect(await readExactly(readerA, 90)).toEqual(payload(90, round));
    }
    await a.close();
  });

  it("small writes still coalesce into full blocks while the window is full", async () => {
    const p = pair({ receiveWindowBlocks: 1 });
    const { a, b } = await openPair(p, { blockSize: 65536, window: 1 });
    const readerB = b.readable.getReader();
    // Unawaited: they pile up in the buffer behind the one block in flight.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 64; i++) writes.push(a.write(payload(4096, i)));
    const expected = concatBytes(Array.from({ length: 64 }, (_, i) => payload(4096, i)));
    const [got] = await Promise.all([readExactly(readerB, expected.length), ...writes]);
    expect(got).toEqual(expected);
    const blocks = p.wire.filter((e) => e.kind === "data" && e.dir === "a>b").length;
    // 64 x 4 KiB = 4 blocks' worth; one stanza per write would be 64.
    expect(blocks).toBeLessThan(10);
    await a.close();
  });

  it("the acceptor sends with the block-size the opener declared", async () => {
    const p = pair();
    const { a, b } = await openPair(p, { blockSize: 300 });
    expect(b.blockSize).toBe(300);
    const readerA = a.readable.getReader();
    const [, got] = await Promise.all([
      (async () => {
        await b.write(payload(1000));
        await b.close();
      })(),
      readExactly(readerA, 1000),
    ]);
    expect(got).toEqual(payload(1000));
    expect(p.wire.filter((e) => e.kind === "data" && e.dir === "b>a")).toHaveLength(4);
  });
});

describe("duplex IBB: closing", () => {
  for (const closer of ["opener", "acceptor"] as const) {
    it(`a <close/> from the ${closer} ends both directions on both sides`, async () => {
      const p = pair();
      const { a, b } = await openPair(p);
      const [local, remote] = closer === "opener" ? [a, b] : [b, a];
      const localReader = local.readable.getReader();
      const remoteReader = remote.readable.getReader();

      // Some traffic first, both ways, so both seq counters have moved.
      await Promise.all([
        local.write(payload(512)),
        remote.write(payload(1024)),
        readExactly(remoteReader, 512),
        readExactly(localReader, 1024),
      ]);

      // Only the local side closes here, with a write still unawaited: close()
      // delivers everything written before it, then the <close/>.
      p.wire.length = 0;
      const lastWrite = local.write(payload(300, 9));
      await local.close();
      await lastWrite;
      expect(await readExactly(remoteReader, 300)).toEqual(payload(300, 9));
      expect(await ending(remoteReader)).toBe("eof");
      expect(await ending(localReader)).toBe("eof");

      // No half-close: the peer's direction is over too.
      const err = await remote.write(payload(10)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpxError);
      expect((err as HttpxError).message).toContain("closed by peer");
      // And its close() is done already — it does not send a second <close/>.
      await remote.close();
      await settle();
      expect(p.wire.filter((e) => e.kind === "close")).toHaveLength(1);
      expect(p.wire.filter((e) => e.kind === "close")[0]?.dir).toBe(
        closer === "opener" ? "a>b" : "b>a",
      );
    });
  }

  it("both sides closing at the same moment both succeed", async () => {
    // The two <close/>s cross on the wire. Each side answers the other's
    // after it has already retired its own state — without the tombstone
    // both would answer item-not-found and both close() calls would reject on
    // a tunnel that both sides closed cleanly.
    const p = pair();
    const { a, b } = await openPair(p);
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();
    await Promise.all([a.write(payload(100)), b.write(payload(100))]);

    const results = await Promise.allSettled([a.close(), b.close()]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    // Both really went out: this is the crossing case, not one side closing.
    expect(p.wire.filter((e) => e.kind === "close").map((e) => e.dir).sort()).toEqual([
      "a>b",
      "b>a",
    ]);
    expect(await readExactly(readerB, 100)).toEqual(payload(100));
    expect(await readExactly(readerA, 100)).toEqual(payload(100));
    expect(await ending(readerA)).toBe("eof");
    expect(await ending(readerB)).toBe("eof");
  });

  it("a peer <close/> releases a writer parked on a full window", async () => {
    const p = pair({ receiveWindowBlocks: 1 });
    const { a, b } = await openPair(p, { blockSize: 65536, window: 2 });
    // Nobody reads at b: a's writer parks once b's buffer and a's window fill.
    const writing = writeAll(a, payload(65536 * 20), 65536).catch((e: unknown) => e);
    await settle();
    const sent = p.wire.filter((e) => e.kind === "data").length;
    expect(sent).toBeLessThan(20);

    await b.close();
    const err = await writing;
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).message).toContain("closed by peer");
    // a's own close() is then a no-op, not a hang.
    await a.close();
  });

  it("cancelling the reader tears the tunnel down, since there is no half-close", async () => {
    const p = pair();
    const { a, b } = await openPair(p);
    const readerB = b.readable.getReader();
    await a.readable.cancel(new Error("reader gone"));
    expect(await ending(readerB)).toBe("eof");
    const err = await b.write(payload(10)).catch((e: unknown) => e);
    expect((err as HttpxError).message).toContain("closed by peer");
    await expect(a.write(payload(10))).rejects.toThrow("reader gone");
  });

  it("abort() sends <close/> and fails the local reader with the reason", async () => {
    const p = pair();
    const { a, b } = await openPair(p);
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();
    const reason = new HttpxError("aborted", "destination reset");
    await a.abort(reason);
    expect(await ending(readerA)).toBe(reason);
    expect(await ending(readerB)).toBe("eof");
    expect(p.wire.filter((e) => e.kind === "close")).toHaveLength(1);
  });

  it("a refused block tears the whole tunnel down, and tells the peer", async () => {
    // A plain sender that fails stays silent until someone writes or closes,
    // and the peer's watchdog reaps its half. A tunnel has neither: nobody
    // may be writing, and the peer has no watchdog. So the failure itself
    // ends both halves and sends <close/>.
    const p = pair({ receiveWindowBlocks: 1 });
    p.opener.idleTimeoutMs = 20; // ack deadline 20 x window 2 = 40 ms
    const { a, b } = await openPair(p, { blockSize: 65536, window: 2 });
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();
    // Nobody reads at b, whose watchdog is off: it withholds acks for good,
    // so a's blocks time out.
    const failure = await writeAll(a, payload(65536 * 8), 65536).catch((e: unknown) => e);
    expect((failure as HttpxError).code).toBe("timeout");

    // No abort(), no close(): the failure alone ended our reader...
    expect(await ending(readerA)).toBe(failure);
    // ...and the peer's, which ends (with what it had queued) instead of
    // waiting out the session.
    const atB = await (async () => {
      let n = 0;
      for (;;) {
        const { done, value } = await readerB.read();
        if (done) return n;
        n += value.length;
      }
    })();
    expect(atB).toBeLessThan(65536 * 8);
    expect(p.wire.filter((e) => e.kind === "close" && e.dir === "a>b")).toHaveLength(1);
    // abort() and close() afterwards are harmless and send nothing more.
    await a.abort(new Error("after the fact"));
    expect(await a.close().catch((e: unknown) => e)).toBe(failure);
    await settle();
    expect(p.wire.filter((e) => e.kind === "close" && e.dir === "a>b")).toHaveLength(1);

    // The sid is free on both sides again.
    const again = await openPair(p);
    await again.a.close();
  });

  it("abort() during a draining close() stops the pump: nothing follows <close/>", async () => {
    for (const how of ["abort", "cancel"] as const) {
      const p = pair({ receiveWindowBlocks: 1 });
      // 64 KiB blocks: b buffers two, then withholds acks (nobody reads),
      // so close() is still draining when the abort lands.
      const { a, b } = await openPair(p, { blockSize: 65536, window: 2 });
      const readerB = b.readable.getReader();
      const writing = a.write(payload(65536 * 6)).catch((e: unknown) => e);
      const closing = a.close().catch((e: unknown) => e);
      await settle();
      expect(p.wire.filter((e) => e.kind === "close"), how).toHaveLength(0);
      const reason = new Error("boom");
      if (how === "abort") await a.abort(reason);
      else await a.readable.cancel(reason);
      await writing;
      // close() reports the abort, not the peer's refusal of stray data.
      expect(await closing).toBe(reason);
      await settle();
      const out = p.wire.filter((e) => e.dir === "a>b" && e.kind !== "open");
      const firstClose = out.findIndex((e) => e.kind === "close");
      expect(firstClose, how).toBeGreaterThanOrEqual(0);
      expect(out.slice(firstClose + 1), how).toEqual([]);
      expect(await ending(readerB)).toBe("eof");
    }
  });

  it("two overlapping close() calls both succeed, deliver everything, send one <close/>", async () => {
    const p = pair({ receiveWindowBlocks: 1 });
    const { a, b } = await openPair(p, { blockSize: 4096, window: 2 });
    const readerB = b.readable.getReader();
    const body = payload(4096 * 6, 5);
    const writing = a.write(body);
    const first = a.close();
    const second = a.close();
    const [got] = await Promise.all([readExactly(readerB, body.length), writing, first, second]);
    expect(got).toEqual(body);
    expect(await ending(readerB)).toBe("eof");
    expect(p.wire.filter((e) => e.kind === "close")).toHaveLength(1);
  });

  it("a block the peer refuses fails the sender, though the peer closes right after", async () => {
    // The receiver kills the stream on a seq gap and closes it. Its <close/>
    // must not overtake its refusal — or the sender, seeing "closed by
    // peer" first, would forgive the refused block and report success.
    const [sa, sb] = createSessionPair(OPENER, ACCEPTOR);
    let n = 0;
    sa.deliverHook = (stanza, deliver) => {
      const data = stanza.getChild("data", NS_IBB);
      if (data && ++n === 3) data.attrs["seq"] = "99";
      queueMicrotask(deliver);
    };
    const fromB: string[] = [];
    sb.deliverHook = (stanza, deliver) => {
      if (stanza.attrs["type"] === "error") fromB.push("error");
      if (stanza.getChild("close", NS_IBB)) fromB.push("close");
      queueMicrotask(deliver);
    };
    const opener = IbbManager.acquire(sa);
    const acceptor = IbbManager.acquire(sb);
    cleanups.push(() => {
      opener.release();
      acceptor.release();
    });
    const { a, b } = await openPair({ opener, acceptor, wire: [] }, { blockSize: 512 });
    const readerB = b.readable.getReader();
    const outcome = await (async () => {
      await writeAll(a, payload(512 * 6), 512);
      await a.close();
      return "ok";
    })().catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(HttpxError);
    expect((await ending(readerB)) as HttpxError).toBeInstanceOf(HttpxError);
    // The acceptor's own order on the wire: the refusal, then the <close/>.
    await settle();
    const firstError = fromB.indexOf("error");
    expect(firstError).toBeGreaterThanOrEqual(0);
    expect(fromB.indexOf("close")).toBeGreaterThan(firstError);
  });

  it("an <open> that times out is followed by <close/>: the peer may have accepted", async () => {
    const [sa, sb] = createSessionPair(OPENER, ACCEPTOR);
    // The acceptor's answer to the <open> is lost; everything else flows.
    sb.deliverHook = (stanza, deliver) => {
      if (stanza.attrs["type"] === "result" && dropNextResult) {
        dropNextResult = false;
        return;
      }
      queueMicrotask(deliver);
    };
    let dropNextResult = true;
    const opener = IbbManager.acquire(sa);
    const acceptor = IbbManager.acquire(sb);
    cleanups.push(() => {
      opener.release();
      acceptor.release();
    });
    opener.idleTimeoutMs = 50; // the <open>'s own IQ deadline
    const accepting = acceptor.expectDuplex(OPENER, "t");
    const opening = opener.openDuplex(ACCEPTOR, { sid: "t" }).catch((e: unknown) => e);
    const b = await accepting; // the acceptor did accept
    expect(((await opening) as HttpxError).code).toBe("timeout");
    // Without the <close/> this half, watchdog off, would live forever.
    expect(await ending(b.readable.getReader())).toBe("eof");
  });

  it("refuses to open a sid that is already open, or already expected", async () => {
    const p = pair();
    const { a } = await openPair(p);
    await expect(p.opener.openDuplex(ACCEPTOR, { sid: "t" })).rejects.toThrow("already in use");
    // The existing tunnel is untouched by the refused attempt.
    const readerB = (await (async () => a)()).sid;
    expect(readerB).toBe("t");
    await a.close();
  });

  it("a stale handle cannot tear down a newer stream on the same sid", async () => {
    const p = pair();
    const first = await openPair(p);
    await first.a.close();
    const second = await openPair(p); // same sid "t", both sides
    // Late teardown of the old handle — e.g. an abort() scheduled before
    // the close finished — must leave the new stream's registration alone.
    await first.a.abort(new Error("stale"));
    await first.b.abort(new Error("stale"));
    const readerA = second.a.readable.getReader();
    const readerB = second.b.readable.getReader();
    await Promise.all([
      second.a.write(payload(300)),
      second.b.write(payload(200)),
    ]);
    expect(await readExactly(readerB, 300)).toEqual(payload(300));
    expect(await readExactly(readerA, 200)).toEqual(payload(200));
    await second.a.close();
  });

  it("the acceptor answers from the JID the <open> was addressed to (components)", async () => {
    // A component receives for every JID at its domain; its session JID is
    // the bare domain. Replies must come from the addressed JID, or the
    // opener — which keys the stream by that JID — refuses them.
    const [a, b] = createSessionPair(OPENER, "gateway.example.org");
    const opener = IbbManager.acquire(a);
    const acceptor = IbbManager.acquire(b);
    cleanups.push(() => {
      opener.release();
      acceptor.release();
    });
    const accepting = acceptor.expectDuplex(OPENER, "t");
    const da = await opener.openDuplex("exit@gateway.example.org", { sid: "t" });
    const db = await accepting;
    const readerA = da.readable.getReader();
    await db.write(payload(100));
    expect(await readExactly(readerA, 100)).toEqual(payload(100));
    await db.close();
  });

  it("a refused <open> leaves nothing registered", async () => {
    const p = pair();
    p.acceptor.acceptTimeoutMs = 20; // no expectDuplex: parked, then refused
    await expect(p.opener.openDuplex(ACCEPTOR, { sid: "t" })).rejects.toBeInstanceOf(
      HttpxError,
    );
    // Same sid again, now accepted: the first attempt's inbound half is gone.
    const accepting = p.acceptor.expectDuplex(OPENER, "t");
    const a = await p.opener.openDuplex(ACCEPTOR, { sid: "t" });
    const b = await accepting;
    const readerB = b.readable.getReader();
    await a.write(payload(10));
    await a.close();
    expect(await readExactly(readerB, 10)).toEqual(payload(10));
  });
});

/**
 * A peer that is not this library: IBB handlers the test drives. Our own
 * acceptor hides several guards — its tombstone answers a crossing <close/>,
 * it acks what arrives after it closed, it refuses before it closes — so
 * each of those guards is only observable against a peer that does less.
 */
interface Foreign {
  opener: IbbManager;
  /** Every <data/> the peer saw: seq, and whether it came after its <close/>. */
  data: Array<{ seq: number; afterClose: boolean }>;
  /** Stop answering <data/>; held blocks stay unanswered until release(). */
  hold(): void;
  /** Answer every held block (and later ones) with this condition. */
  release(condition?: string): void;
  /** Send our <close/> to the opener, as a peer closing the tunnel would. */
  closeFromPeer(): Promise<void>;
  /** How the peer answers the opener's <close/>. */
  onOpenerClose: () => Promise<Element | boolean> | Element | boolean;
}

function foreignPeer(): Foreign {
  const [a, b] = createSessionPair(OPENER, ACCEPTOR);
  const data: Foreign["data"] = [];
  const held: Array<(reply: Element | boolean) => void> = [];
  let holding = false;
  let answerWith: string | undefined;
  let closed = false;
  const reply = (): Element | boolean =>
    answerWith
      ? xml("error", { type: "cancel" }, xml(answerWith, { xmlns: NS_STANZAS }))
      : true;
  const peer: Foreign = {
    opener: IbbManager.acquire(a),
    data,
    hold: () => {
      holding = true;
    },
    release: (condition) => {
      answerWith = condition;
      holding = false;
      for (const r of held.splice(0)) r(reply());
    },
    closeFromPeer: async () => {
      closed = true;
      await b.iqCaller.request(
        xml("iq", { type: "set", to: OPENER }, xml("close", { xmlns: NS_IBB, sid: "t" })),
      );
    },
    onOpenerClose: () => true,
  };
  b.iqCallee.set(NS_IBB, "open", () => true);
  b.iqCallee.set(NS_IBB, "close", () => peer.onOpenerClose());
  b.iqCallee.set(NS_IBB, "data", (ctx) => {
    data.push({ seq: Number(ctx.element.attrs["seq"]), afterClose: closed });
    if (!holding) return reply();
    return new Promise<Element | boolean>((resolve) => held.push(resolve));
  });
  cleanups.push(() => peer.opener.release());
  return peer;
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms),
    ),
  ]);
}

describe("duplex IBB against a peer that is not this library", () => {
  it("a peer <close/> releases parked writers and close() even if its acks never come", async () => {
    const peer = foreignPeer();
    const a = await peer.opener.openDuplex(ACCEPTOR, { sid: "t", blockSize: 512, window: 2 });
    peer.hold(); // the peer will never answer what is in flight
    const writing = a.write(payload(512 * 10)).catch((e: unknown) => e);
    await settle();
    await peer.closeFromPeer();
    const err = await within(writing, 1_000, "write()");
    expect((err as HttpxError).message).toContain("closed by peer");
    await within(a.close(), 1_000, "close()");
  });

  it("stops sending the moment the peer closes: at most the window was in flight", async () => {
    const peer = foreignPeer();
    const a = await peer.opener.openDuplex(ACCEPTOR, { sid: "t", blockSize: 512, window: 2 });
    peer.hold();
    const writing = a.write(payload(512 * 20)).catch((e: unknown) => e);
    await settle();
    await peer.closeFromPeer();
    // Its state is gone now: whatever still arrives is item-not-found.
    peer.release("item-not-found");
    await within(writing, 1_000, "write()");
    await settle();
    expect(peer.data.filter((d) => d.afterClose)).toEqual([]);
    // And the in-flight blocks it refused as unknown, having closed, are the
    // ordinary cost of the tunnel ending — not a failure close() reports.
    await within(a.close(), 1_000, "close()");
  });

  it("a peer <close/> ends a close() that is already waiting for acks", async () => {
    const peer = foreignPeer();
    const a = await peer.opener.openDuplex(ACCEPTOR, { sid: "t", blockSize: 512, window: 2 });
    peer.hold(); // the acks close() waits for will never come
    await a.write(payload(512 * 2));
    const closing = a.close();
    await settle();
    await peer.closeFromPeer();
    await within(closing, 1_000, "close()");
  });

  it("closes cleanly when the <close/>s cross and the peer answers ours item-not-found", async () => {
    // What a peer without a tombstone does: it sends its <close/>, forgets
    // the stream, and refuses ours.
    const peer = foreignPeer();
    const a = await peer.opener.openDuplex(ACCEPTOR, { sid: "t", blockSize: 512 });
    peer.onOpenerClose = async () => {
      await peer.closeFromPeer();
      return xml("error", { type: "cancel" }, xml("item-not-found", { xmlns: NS_STANZAS }));
    };
    await within(a.close(), 1_000, "close()");
  });

  it("a block refused after the peer's <close/> is still a failure unless it is item-not-found", async () => {
    const peer = foreignPeer();
    const a = await peer.opener.openDuplex(ACCEPTOR, { sid: "t", blockSize: 512, window: 4 });
    peer.hold();
    const writing = a.write(payload(512 * 4)).catch((e: unknown) => e);
    await settle();
    await peer.closeFromPeer(); // closes first, then refuses what it held
    peer.release("unexpected-request");
    await writing;
    // close() after a peer <close/> does not wait on outstanding blocks — a
    // vanished peer would hold it for the ack deadline — but a refusal that
    // lands is latched, not forgiven as an ordinary post-close discard.
    await settle();
    const outcome = await a.close().catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(HttpxError);
    expect((outcome as HttpxError).message).toContain("unexpected-request");
  });

  it("abort() during a draining close() returns promptly even if no ack ever comes", async () => {
    const peer = foreignPeer();
    const a = await peer.opener.openDuplex(ACCEPTOR, { sid: "t", blockSize: 512, window: 2 });
    peer.hold();
    await a.write(payload(512 * 2));
    const closing = a.close().catch((e: unknown) => e);
    await settle();
    const reason = new Error("deadline");
    await a.abort(reason);
    expect(await within(closing, 1_000, "close()")).toBe(reason);
  });
});

describe("duplex IBB: watchdogs", () => {
  it("a tunnel's watchdog is off: it outlives the idle timeout, then still works", async () => {
    const p = pair({ receiveWindowBlocks: 1 });
    p.opener.idleTimeoutMs = 30;
    p.acceptor.idleTimeoutMs = 30;
    const { a, b } = await openPair(p); // duplex default: idleTimeoutMs false
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();

    await sleep(150); // five idle timeouts of silence
    const [, , atB, atA] = await Promise.all([
      a.write(payload(512, 1)),
      b.write(payload(512, 2)),
      readExactly(readerB, 512),
      readExactly(readerA, 512),
    ]);
    expect(atB).toEqual(payload(512, 1));
    expect(atA).toEqual(payload(512, 2));
    await a.close();
    expect(await ending(readerB)).toBe("eof");
  });

  it("the stalled deadline is off too: an unread tunnel is not reaped", async () => {
    // The body rule reaps a receiver that withholds acks for idle x (w + 1).
    // A tunnel whose local side is slow to drain — a destination socket
    // pushing back — is not dead, and must not be killed for it.
    const p = pair({ receiveWindowBlocks: 1 });
    p.acceptor.idleTimeoutMs = 20; // body stalled budget would be 40 ms
    const { a, b } = await openPair(p, { blockSize: 65536, window: 8 });
    const writing = a.write(payload(65536 * 8));
    await sleep(200);
    const readerB = b.readable.getReader();
    expect(await readExactly(readerB, 65536 * 8)).toHaveLength(65536 * 8);
    await writing;
    await a.close();
    expect(await ending(readerB)).toBe("eof");
  });

  it("a duplex given a number counts acks as liveness: a one-way upload is not idle", async () => {
    const p = pair();
    p.opener.idleTimeoutMs = 5_000; // ack deadline, not under test
    const { a, b } = await openPair(p, { blockSize: 512, openerIdle: 80 });
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();
    // 400 ms of upload in 20 ms steps: five idle timeouts, nothing inbound.
    const reading = readExactly(readerB, 512 * 20);
    for (let i = 0; i < 20; i++) {
      await a.write(payload(512, i));
      await sleep(20);
    }
    await reading;
    await a.close();
    expect(await ending(readerA)).toBe("eof");
  });

  it("a duplex given a number times out, and takes the whole stream down", async () => {
    const p = pair();
    const { a, b } = await openPair(p, { acceptorIdle: 40 });
    const readerA = a.readable.getReader();
    const readerB = b.readable.getReader();
    const outcome = await ending(readerB);
    expect(outcome).toBeInstanceOf(HttpxError);
    expect((outcome as HttpxError).code).toBe("timeout");
    // Its fatal inbound error aborted the duplex: the peer heard <close/>.
    expect(await ending(readerA)).toBe("eof");
  });

  it("a body keeps its watchdog: plain streams still time out on the manager's idle", async () => {
    const p = pair();
    p.acceptor.idleTimeoutMs = 40;
    const incoming = p.acceptor.expectIncoming(OPENER, "body");
    await p.opener.openOutgoing(ACCEPTOR, { sid: "body" });
    const stream = await incoming;
    const outcome = await ending(stream.readable.getReader());
    expect((outcome as HttpxError).code).toBe("timeout");
  });

  it("a body's watchdog is per stream: expectIncoming can override the manager", async () => {
    const p = pair();
    p.acceptor.idleTimeoutMs = 10_000;
    const incoming = p.acceptor.expectIncoming(OPENER, "body", { idleTimeoutMs: 40 });
    const out = await p.opener.openOutgoing(ACCEPTOR, { sid: "body" });
    const stream = await incoming;
    const started = Date.now();
    const outcome = await ending(stream.readable.getReader());
    expect((outcome as HttpxError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    await out.abort(new Error("done"));
  });
});

describe("per-stream watchdogs reach HttpxClient", () => {
  it("the client's idleTimeoutMs now bounds an IBB body, not just its <open>", async () => {
    // Before per-stream watchdogs the option set only the wait for <open>;
    // the stream itself timed out on the manager's 30 s, whatever it said.
    const [clientSession, serverSession] = createSessionPair();
    const server = new HttpxServer(serverSession, { authorize: allowAll() });
    server.handle(() => ({
      status: 200,
      // A length, so the body streams: without one the server buffers the
      // whole stream first (Number(null) is 0 — a separate, older bug).
      headers: { "content-length": "100000" },
      body: new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(payload(100)), // then silence
      }),
    }));
    server.start();
    const client = new HttpxClient(clientSession, {
      discover: false,
      idleTimeoutMs: 60,
      accept: { sipub: false, jingle: false },
    });
    cleanups.push(async () => {
      await client.close();
      server.stop();
    });
    const resp = await client.request("server@example.org");
    const started = Date.now();
    const outcome = await ending(resp.body!.getReader());
    expect((outcome as HttpxError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("per-stream watchdogs reach HttpxServer", () => {
  it("the server's idleTimeoutMs now bounds an IBB request body", async () => {
    const [clientSession, serverSession] = createSessionPair();
    let seen: unknown;
    const server = new HttpxServer(serverSession, { authorize: allowAll(), idleTimeoutMs: 60 });
    server.handle(async (req) => {
      const reader = req.body!.getReader();
      seen = await ending(reader);
      return { status: 408 };
    });
    server.start();
    const client = new HttpxClient(clientSession, { discover: false });
    const controller = new AbortController();
    cleanups.push(async () => {
      controller.abort();
      await client.close();
      server.stop();
    });
    // A body that sends a block and then goes quiet for good.
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(payload(8192)),
    });
    void client
      .request("server@example.org", { method: "POST", body, signal: controller.signal })
      .catch(() => {});
    for (let i = 0; i < 200 && seen === undefined; i++) await sleep(10);
    expect((seen as HttpxError).code).toBe("timeout");
  });
});

// ------------------------------------------------------------------ CONNECT

function setup(handler: HttpxHandler, serverOptions: HttpxServerOptions = {}) {
  const [clientSession, serverSession] = createSessionPair();
  const wire: WireEvent[] = [];
  tapIbb(clientSession, serverSession, wire);
  const errors: unknown[] = [];
  const server = new HttpxServer(serverSession, {
    authorize: allowAll(),
    onError: (err) => errors.push(err),
    ...serverOptions,
  });
  server.handle(handler);
  server.start();
  const client = new HttpxClient(clientSession, { discover: false });
  cleanups.push(async () => {
    await client.close();
    server.stop();
  });
  return { client, server, clientSession, serverSession, wire, errors };
}

describe("CONNECT tunnels", () => {
  it("a 2xx with a tunnel callback gives both sides one duplex stream", async () => {
    const toDestination = payload(40_000, 3);
    const fromDestination = payload(50_000, 4);
    let seen: { method: string; resource: string; url: string } | undefined;
    let atExit: Promise<Uint8Array> | undefined;

    const { client, wire } = setup((req) => {
      seen = { method: req.method, resource: req.resource, url: req.url };
      return {
        status: 200,
        tunnel: (tunnel: HttpxTunnel) => {
          // The exit's side of the pipe: read what the client sends while
          // sending the destination's bytes back, concurrently.
          const reader = tunnel.readable.getReader();
          atExit = readExactly(reader, toDestination.length);
          void writeAll(tunnel, fromDestination);
        },
      };
    });

    const { response, tunnel } = await client.connect("server@example.org", {
      authority: "example.org:443",
    });
    expect(response.statusCode).toBe(200);
    expect(response.statusMessage).toBe("Connection Established");
    expect(response.body).toBeNull();
    expect(tunnel).not.toBeNull();
    expect(seen).toEqual({
      method: "CONNECT",
      resource: "example.org:443",
      url: "example.org:443",
    });

    const reader = tunnel!.readable.getReader();
    const [, atClient] = await Promise.all([
      writeAll(tunnel!, toDestination),
      readExactly(reader, fromDestination.length),
    ]);
    expect(atClient).toEqual(fromDestination);
    expect(await atExit).toEqual(toDestination);

    await tunnel!.close();
    expect(await ending(reader)).toBe("eof");
    // The exit opened the one stream; the client never sent an <open>.
    expect(wire.filter((e) => e.kind === "open").map((e) => e.dir)).toEqual(["b>a"]);
  });

  it("a non-2xx answer is an ordinary response and the tunnel callback never runs", async () => {
    let called = false;
    const { client, wire } = setup(() => ({
      status: 502,
      body: "connection refused",
      tunnel: () => {
        called = true;
      },
    }));
    const { response, tunnel } = await client.connect("server@example.org", {
      authority: "example.org:443",
    });
    expect(response.statusCode).toBe(502);
    expect(await response.text()).toBe("connection refused");
    expect(tunnel).toBeNull();
    await settle();
    expect(called).toBe(false);
    expect(wire.filter((e) => e.kind === "open")).toHaveLength(0);
  });

  it("the tunnel's watchdog is off end to end", async () => {
    let exitSide: HttpxTunnel | undefined;
    const { client, serverSession, clientSession } = setup(() => ({
      status: 200,
      tunnel: (t: HttpxTunnel) => {
        exitSide = t;
      },
    }));
    IbbManager.acquire(serverSession).idleTimeoutMs = 30;
    IbbManager.acquire(clientSession).idleTimeoutMs = 30;
    cleanups.push(() => {
      IbbManager.acquire(serverSession).release();
      IbbManager.acquire(clientSession).release();
    });
    const { tunnel } = await client.connect("server@example.org", {
      authority: "example.org:443",
    });
    await sleep(150);
    const reader = exitSide!.readable.getReader();
    await tunnel!.write(payload(100));
    await tunnel!.close();
    expect(await readExactly(reader, 100)).toEqual(payload(100));
  });

  it("the handler still hears about a tunnel that never opened", async () => {
    // The requester vanished between <resp> and <open>. The handler has
    // already dialled the destination; it must learn to hang up.
    let handed: HttpxTunnel | undefined;
    const handedOver = new Promise<void>((resolve) => {
      void (async () => {
        while (!handed) await sleep(5);
        resolve();
      })();
    });
    const { clientSession, errors } = setup(() => ({
      status: 200,
      tunnel: (t: HttpxTunnel) => {
        handed = t;
      },
    }));
    // A raw CONNECT from a session whose IBB manager refuses unclaimed opens
    // quickly — nobody calls expectDuplex().
    const ibb = IbbManager.acquire(clientSession);
    ibb.acceptTimeoutMs = 20;
    cleanups.push(() => ibb.release());
    const reply = await clientSession.iqCaller.request(
      xml(
        "iq",
        { type: "set", to: "server@example.org" },
        encodeReq({
          method: "CONNECT",
          resource: "example.org:443",
          version: "1.1",
          accept: { ibb: true, sipub: false, jingle: false },
          headers: new Headers(),
        }),
      ),
    );
    expect(decodeResp(reply.getChild("resp", NS_HTTPX)!).statusCode).toBe(200);
    await handedOver;
    expect(await ending(handed!.readable.getReader())).toBeInstanceOf(Error);
    await expect(handed!.write(payload(1))).rejects.toBeInstanceOf(Error);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("refuses a CONNECT whose requester does not accept IBB, before the handler dials", async () => {
    let called = false;
    const { clientSession } = setup(() => {
      called = true;
      return { status: 200, tunnel: () => {} };
    });
    const reply = await clientSession.iqCaller.request(
      xml(
        "iq",
        { type: "set", to: "server@example.org" },
        encodeReq({
          method: "CONNECT",
          resource: "example.org:443",
          version: "1.1",
          accept: { ibb: false, sipub: true, jingle: true },
          headers: new Headers(),
        }),
      ),
    );
    expect(decodeResp(reply.getChild("resp", NS_HTTPX)!).statusCode).toBe(501);
    expect(called).toBe(false);
  });

  it("refuses a CONNECT that carries content (RFC 9110 §9.3.6)", async () => {
    let called = false;
    const { clientSession } = setup(() => {
      called = true;
      return { status: 200, tunnel: () => {} };
    });
    const reply = await clientSession.iqCaller.request(
      xml(
        "iq",
        { type: "set", to: "server@example.org" },
        encodeReq({
          method: "CONNECT",
          resource: "example.org:443",
          version: "1.1",
          accept: { ibb: true, sipub: false, jingle: false },
          headers: new Headers(),
          data: { kind: "text", text: "smuggled" },
        }),
      ),
    );
    expect(decodeResp(reply.getChild("resp", NS_HTTPX)!).statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it("a tunnel answer with a body is a handler bug, answered 500", async () => {
    let called = false;
    const { client, errors } = setup(() => ({
      status: 200,
      body: "not allowed",
      tunnel: () => {
        called = true;
      },
    }));
    const { response, tunnel } = await client.connect("server@example.org", {
      authority: "example.org:443",
    });
    expect(response.statusCode).toBe(500);
    expect(tunnel).toBeNull();
    expect(String(errors[0])).toContain("carries no body");
    await settle();
    expect(called).toBe(false);
  });

  it("a tunnel callback that throws has its tunnel aborted", async () => {
    const { client, errors } = setup(() => ({
      status: 200,
      tunnel: () => {
        throw new Error("destination went away");
      },
    }));
    const { tunnel } = await client.connect("server@example.org", {
      authority: "example.org:443",
    });
    // Our side hears the exit's <close/> instead of waiting forever.
    expect(await ending(tunnel!.readable.getReader())).toBe("eof");
    expect(String(errors[0])).toContain("destination went away");
  });

  it("connect() says on the wire that only IBB will do", async () => {
    const [clientSession, exitSession] = createSessionPair();
    let seen: Record<string, string | undefined> | undefined;
    exitSession.iqCallee.set(NS_HTTPX, "req", (ctx) => {
      seen = { ...ctx.element.attrs };
      return encodeResp({ version: "1.1", statusCode: 403, statusMessage: "Forbidden", headers: new Headers() });
    });
    const client = new HttpxClient(clientSession, { discover: false });
    cleanups.push(() => client.close());
    const { response } = await client.connect("server@example.org", { authority: "example.org:443" });
    expect(response.statusCode).toBe(403);
    expect(seen?.["method"]).toBe("CONNECT");
    expect(seen?.["sipub"]).toBe("false");
    expect(seen?.["jingle"]).toBe("false");
    expect(seen?.["ibb"]).toBeUndefined(); // default true
  });

  it("a tunnel whose <open> lands after connect() was aborted is closed, not leaked", async () => {
    const controller = new AbortController();
    let exitSide: HttpxTunnel | undefined;
    const { client, serverSession } = setup(() => ({
      status: 200,
      tunnel: (t: HttpxTunnel) => {
        exitSide = t;
      },
    }));
    // Abort the moment the exit's <open> is on its way, before it arrives.
    const deliverOpen = serverSession.deliverHook!;
    serverSession.deliverHook = (stanza, deliver) => {
      if (stanza.getChild("open", NS_IBB)) {
        controller.abort();
        setTimeout(() => deliverOpen(stanza, deliver), 10);
        return;
      }
      deliverOpen(stanza, deliver);
    };
    const outcome = await client
      .connect("server@example.org", { authority: "example.org:443", signal: controller.signal })
      .catch((e: unknown) => e);
    expect((outcome as HttpxError).code).toBe("aborted");
    for (let i = 0; i < 50 && !exitSide; i++) await sleep(5);
    // The duplex nobody holds was aborted on arrival: the exit hears <close/>.
    expect(await within(ending(exitSide!.readable.getReader()), 2_000, "exit reader")).toBe("eof");
  });
  it("a tunnel on anything but CONNECT is a handler bug, answered 500", async () => {
    const { client, errors } = setup(() => ({ status: 200, tunnel: () => {} }));
    const resp = await client.request("server@example.org", { resource: "/" });
    expect(resp.statusCode).toBe(500);
    expect(String(errors[0])).toContain("CONNECT only");
  });

  it("request() refuses CONNECT and points at connect()", async () => {
    const { client } = setup(() => ({ status: 200 }));
    await expect(
      client.request("server@example.org", {
        method: "CONNECT",
        resource: "example.org:443",
      }),
    ).rejects.toThrow("use HttpxClient.connect()");
  });

  it("connect() insists on an authority-form target", async () => {
    const { client } = setup(() => ({ status: 200 }));
    for (const bad of ["/path", "https://example.org/", "example.org"]) {
      await expect(
        client.connect("server@example.org", { authority: bad }),
      ).rejects.toBeInstanceOf(HttpxError);
    }
  });

  it("a 2xx without a stream is a protocol error, not a silent dead pipe", async () => {
    // Our server never sends one (next test); a foreign exit might. Both a
    // bare 2xx and a 2xx carrying an ordinary body must be refused.
    for (const data of [undefined, { kind: "text" as const, text: "hello" }]) {
      const [clientSession, exitSession] = createSessionPair();
      exitSession.iqCallee.set(NS_HTTPX, "req", () =>
        encodeResp({
          version: "1.1",
          statusCode: 200,
          statusMessage: "OK",
          headers: new Headers(),
          ...(data ? { data } : {}),
        }),
      );
      const client = new HttpxClient(clientSession, { discover: false });
      cleanups.push(() => client.close());
      await expect(
        client.connect("server@example.org", { authority: "example.org:443" }),
      ).rejects.toThrow("without an IBB stream");
    }
  });

  it("a 2xx CONNECT answer without a tunnel is a handler bug, answered 500", async () => {
    for (const answer of [
      () => ({ status: 200, body: payload(100_000) }),
      () => new Response("x".repeat(100_000), { status: 200 }),
    ]) {
      const { client, errors, wire } = setup(answer);
      const { response, tunnel } = await client.connect("server@example.org", {
        authority: "example.org:443",
      });
      expect(response.statusCode).toBe(500);
      expect(tunnel).toBeNull();
      expect(String(errors[0])).toContain("needs a tunnel callback");
      // And no one-way stream was opened that could pass for a tunnel.
      await settle();
      expect(wire.filter((e) => e.kind === "open")).toHaveLength(0);
    }
  });

  it("invalid tunnel headers are answered 500 and the handler still gets a dead tunnel", async () => {
    let handed: HttpxTunnel | undefined;
    const { client, errors } = setup(() => ({
      status: 200,
      headers: { "bad header": "x" },
      tunnel: (t: HttpxTunnel) => {
        handed = t;
      },
    }));
    const { response, tunnel } = await client.connect("server@example.org", {
      authority: "example.org:443",
    });
    expect(response.statusCode).toBe(500);
    expect(tunnel).toBeNull();
    for (let i = 0; i < 50 && !handed; i++) await sleep(5);
    expect(handed).toBeDefined();
    await expect(handed!.write(payload(1))).rejects.toBeInstanceOf(Error);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("a server stopped between the reply and the <open> hands over a dead tunnel", async () => {
    let handed: HttpxTunnel | undefined;
    let stop: () => void = () => {};
    const { client, server, wire } = setup(() => {
      // Queued before the server's own timer, so it runs first.
      setTimeout(() => stop(), 0);
      return {
        status: 200,
        tunnel: (t: HttpxTunnel) => {
          handed = t;
        },
      };
    });
    stop = () => server.stop();
    // The client never gets its <open>, so connect() times out waiting.
    const connecting = client
      .connect("server@example.org", { authority: "example.org:443" })
      .catch((e: unknown) => e);
    for (let i = 0; i < 100 && !handed; i++) await sleep(5);
    expect(handed).toBeDefined();
    expect(await ending(handed!.readable.getReader())).toBeInstanceOf(Error);
    expect(wire.filter((e) => e.kind === "open")).toHaveLength(0);
    void connecting;
  });
});
