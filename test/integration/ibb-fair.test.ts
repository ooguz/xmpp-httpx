import xml, { type Element } from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { NS_IBB, NS_STANZAS } from "../../src/constants.js";
import { IbbManager, type IbbOutStream } from "../../src/ibb/ibb.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { createSessionPair } from "../../src/testing/mock-session.js";
import { decodeBase64 } from "../../src/util/base64.js";
import { bytesFromStream, concatBytes } from "../../src/util/bytes.js";

/**
 * The per-session send scheduler (design §5.2, item 3): every IBB stream on a
 * session shares one budget of blocks in flight, and when it is full, freed
 * slots go to the waiting streams in turn. Each stream's own window, ordering
 * and failure rules are unchanged — those are ibb-window.test.ts's; this file
 * is about what happens *between* streams.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function payload(size: number, salt = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + salt) & 0xff;
  return bytes;
}

interface Arrival {
  sid: string;
  seq: number;
  bytes: Uint8Array;
}

interface Receiver {
  sender: IbbManager;
  arrived: Arrival[];
  /** Blocks the peer holds unanswered, oldest first. */
  held(): number;
  /** Stop answering blocks; they queue up. */
  hold(): void;
  /** Answer the oldest held block (with an error condition, optionally). */
  ackOne(condition?: string): void;
  /** Answer the oldest held block of `sid`. */
  ackSid(sid: string, condition?: string): void;
  /** Answer everything held and go back to answering on arrival. */
  resume(): void;
  /** Blocks of `sid` that have arrived and are not yet answered. */
  outstanding(sid?: string): number;
}

/** A peer that is not this library, answering every sid, driven by the test. */
function receiver(): Receiver {
  const [a, b] = createSessionPair("sender@example.org/x", "receiver@example.org");
  const arrived: Arrival[] = [];
  const queue: Array<{ sid: string; answer: (reply: Element | boolean) => void }> = [];
  let holding = false;
  b.iqCallee.set(NS_IBB, "open", () => true);
  b.iqCallee.set(NS_IBB, "close", () => true);
  b.iqCallee.set(NS_IBB, "data", (ctx) => {
    const sid = ctx.element.attrs["sid"] ?? "";
    arrived.push({
      sid,
      seq: Number(ctx.element.attrs["seq"]),
      bytes: decodeBase64(ctx.element.getText()),
    });
    if (!holding) return true;
    return new Promise<Element | boolean>((answer) => queue.push({ sid, answer }));
  });
  const sender = IbbManager.acquire(a);
  cleanups.push(() => sender.release());
  const error = (condition: string) =>
    xml("error", { type: "cancel" }, xml(condition, { xmlns: NS_STANZAS }));
  return {
    sender,
    arrived,
    held: () => queue.length,
    hold: () => {
      holding = true;
    },
    ackOne: (condition) => {
      const next = queue.shift();
      next?.answer(condition ? error(condition) : true);
    },
    ackSid: (sid, condition) => {
      const i = queue.findIndex((q) => q.sid === sid);
      if (i === -1) return;
      const [next] = queue.splice(i, 1);
      next!.answer(condition ? error(condition) : true);
    },
    resume: () => {
      holding = false;
      for (const next of queue.splice(0)) next.answer(true);
    },
    outstanding: (sid) => queue.filter((q) => sid === undefined || q.sid === sid).length,
  };
}

async function open(
  r: Receiver,
  sid: string,
  options?: { window?: number; blockSize?: number },
): Promise<IbbOutStream> {
  return r.sender.openOutgoing("receiver@example.org", {
    sid,
    blockSize: options?.blockSize ?? 64,
    window: options?.window ?? 8,
  });
}

describe("the session budget", () => {
  it("caps blocks in flight across all streams, not per stream", async () => {
    const r = receiver();
    r.sender.sendWindowBlocks = 10;
    const streams = await Promise.all(["a", "b", "c"].map((sid) => open(r, sid)));
    r.hold();
    const writes = streams.map((s) => s.write(payload(64 * 20)).catch((e: unknown) => e));
    await settle();
    // Three windows of 8 would be 24; the session allows 10.
    expect(r.arrived).toHaveLength(10);
    r.resume();
    await Promise.all(writes);
    await Promise.all(streams.map((s) => s.close()));
    expect(r.arrived).toHaveLength(60);
  });

  it("leaves a stream alone at its own window when nothing competes", async () => {
    const r = receiver(); // default budget 16
    const s = await open(r, "a", { window: 8 });
    r.hold();
    const writing = s.write(payload(64 * 20));
    await settle();
    expect(r.arrived).toHaveLength(8);
    r.resume();
    await writing;
    await s.close();
  });

  it("caps a stream whose own window is larger than the session's", async () => {
    const r = receiver();
    r.sender.sendWindowBlocks = 5;
    const s = await open(r, "a", { window: 32 });
    r.hold();
    const writing = s.write(payload(64 * 40));
    await settle();
    expect(r.arrived).toHaveLength(5);
    r.resume();
    await writing;
    await s.close();
  });

  it("never lets a bad budget disable the cap", async () => {
    // NaN and Infinity would admit everything (`n >= NaN` is false); they
    // fall back to the default. Zero and below clamp to one block, which is
    // slow but still bounded — the same rule as a stream's own window.
    for (const [bad, expected] of [[NaN, 16], [Infinity, 16], [0, 1], [-3, 1]] as const) {
      const r = receiver();
      r.sender.sendWindowBlocks = bad;
      const streams = await Promise.all(["a", "b", "c"].map((sid) => open(r, sid)));
      r.hold();
      const writes = streams.map((s) => s.write(payload(64 * 20)).catch((e: unknown) => e));
      await settle();
      expect(r.arrived.length, `budget ${String(bad)}`).toBe(expected);
      r.resume();
      await Promise.all(writes);
    }
  });
});

describe("round-robin between streams", () => {
  it("a stream that arrives late gets every other freed slot", async () => {
    const r = receiver();
    r.sender.sendWindowBlocks = 4;
    const big = await open(r, "big");
    const small = await open(r, "small");
    r.hold();
    const bigWriting = big.write(payload(64 * 40));
    await settle();
    expect(r.arrived.map((a) => a.sid)).toEqual(["big", "big", "big", "big"]);

    const smallWriting = small.write(payload(64 * 4));
    await settle();
    // Session full: the newcomer waits, but in line, not behind all of big.
    for (let i = 0; i < 8; i++) {
      r.ackOne();
      await settle();
    }
    const after = r.arrived.slice(4).map((a) => a.sid);
    expect(after).toEqual(["big", "small", "big", "small", "big", "small", "big", "small"]);
    r.resume();
    await Promise.all([bigWriting, smallWriting]);
  });

  it("one large download does not starve twenty small ones", async () => {
    // The design's own example. The mock has no bandwidth to congest, so
    // this pins slot order, not throughput: a cap alone is not enough —
    // whichever pump is woken first would take every freed slot — and the
    // small streams must finish while the big one has barely begun.
    const r = receiver();
    r.sender.sendWindowBlocks = 8;
    const big = await open(r, "big");
    r.hold();
    const bigWriting = big.write(payload(64 * 400)).catch((e: unknown) => e);
    await settle();
    const smalls = await Promise.all(
      Array.from({ length: 20 }, (_, i) => open(r, `small-${i}`)),
    );
    const smallDone = smalls.map((s, i) =>
      (async () => {
        await s.write(payload(64 * 2, i));
        await s.close();
      })(),
    );
    // Ack one block at a time until every small stream has closed.
    let allDone = false;
    void Promise.all(smallDone).then(() => (allDone = true));
    for (let i = 0; i < 500 && !allDone; i++) {
      r.ackOne();
      await settle(2);
    }
    expect(allDone).toBe(true);
    const bigSent = r.arrived.filter((a) => a.sid === "big").length;
    // 40 small blocks interleaved with big ones: roughly as many big blocks
    // went out as small ones, not all 400.
    expect(bigSent).toBeLessThan(80);
    r.resume();
    await bigWriting;
    await big.close();
  });

  it("keeps each stream's bytes and seqs in order under contention", async () => {
    const r = receiver();
    r.sender.sendWindowBlocks = 3;
    const sids = ["a", "b", "c", "d"];
    const bodies = sids.map((_, i) => payload(64 * 17 + i * 5, i));
    const streams = await Promise.all(sids.map((sid) => open(r, sid, { window: 2 })));
    await Promise.all(
      streams.map(async (s, i) => {
        const body = bodies[i]!;
        for (let o = 0; o < body.length; o += 37) await s.write(body.subarray(o, o + 37));
        await s.close();
      }),
    );
    sids.forEach((sid, i) => {
      const mine = r.arrived.filter((a) => a.sid === sid);
      expect(mine.map((a) => a.seq), sid).toEqual(mine.map((_, k) => k));
      expect(concatBytes(mine.map((a) => a.bytes)), sid).toEqual(bodies[i]);
      expect(Math.max(...mine.map((a) => a.bytes.length)), sid).toBeLessThanOrEqual(64);
    });
  });

  it("close() racing two unawaited writers never sends more than a block", async () => {
    const r = receiver();
    const s = await open(r, "a", { window: 1 });
    const w1 = s.write(payload(64 * 6, 1));
    const w2 = s.write(payload(64 * 6, 2));
    await s.close();
    await Promise.all([w1, w2]);
    const sizes = r.arrived.map((a) => a.bytes.length);
    expect(sizes.reduce((x, y) => x + y, 0)).toBe(64 * 12);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
  });
});

describe("waiting streams come first", () => {
  it("slots that appear outside an ack go to the waiting streams, not a newcomer", async () => {
    // A slot can free up without an ack — the budget raised, or parked
    // blocks reclaimed — and the stream asking at that moment must not take
    // it ahead of those already waiting.
    const r = receiver();
    r.sender.sendWindowBlocks = 2;
    const [a, b, c] = await Promise.all(["a", "b", "c"].map((sid) => open(r, sid)));
    r.hold();
    const writes = [a!.write(payload(64 * 2)), b!.write(payload(64))].map((w) =>
      w.catch((e: unknown) => e),
    );
    await settle();
    expect(r.arrived.map((x) => x.sid)).toEqual(["a", "a"]); // b is waiting
    r.sender.sendWindowBlocks = 3;
    const cWriting = c!.write(payload(64)).catch((e: unknown) => e);
    await settle();
    expect(r.arrived.map((x) => x.sid)).toEqual(["a", "a", "b"]);
    r.resume();
    await Promise.all([...writes, cWriting]);
  });
});

describe("the budget is never leaked", () => {
  /** A fresh stream should get the whole budget once everything settled. */
  async function budgetIsWhole(r: Receiver, budget: number): Promise<void> {
    await settle();
    const fresh = await open(r, "fresh", { window: 64 });
    r.hold();
    const writing = fresh.write(payload(64 * (budget + 10))).catch(() => {});
    await settle();
    expect(r.outstanding("fresh")).toBe(budget);
    r.resume();
    await writing;
  }

  it("after streams abort, fail, and close while waiting for slots", async () => {
    const r = receiver();
    r.sender.sendWindowBlocks = 4;
    const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map((sid) => open(r, sid)));
    r.hold();
    const writes = [a!, b!, c!, d!].map((s) => s.write(payload(64 * 10)).catch((e: unknown) => e));
    await settle();
    // Streams b, c, d are queued behind a's four in-flight blocks. Abort one
    // that is waiting, fail one by refusing its block, close another.
    await c!.abort(new Error("gone"));
    r.ackOne("not-acceptable"); // a's first block: a fails
    await settle();
    r.resume();
    await Promise.all(writes);
    await b!.close();
    await d!.close();
    await a!.close().catch(() => {});
    await budgetIsWhole(r, 4);
  });

  it("after a stream fails between being granted a slot and using it", async () => {
    // A slot freed by one stream's ack is granted to a waiting stream, and a
    // failure of that stream's own earlier block lands before its pump runs.
    // The pump then exits without the block — and must give the grant back.
    const r = receiver();
    r.sender.sendWindowBlocks = 2;
    const b = await open(r, "b", { window: 2 });
    const a = await open(r, "a", { window: 1 });
    r.hold();
    const bWriting = b.write(payload(64)).catch((e: unknown) => e); // b0: slot 1
    await settle();
    const aWriting = a.write(payload(64)).catch((e: unknown) => e); // a0: slot 2
    await settle();
    const bMore = b.write(payload(64)).catch((e: unknown) => e); // b1: queued
    await settle();
    expect(r.held()).toBe(2);
    // a0's ack frees a slot, granted to the waiting b; b0's refusal lands
    // before b's pump runs, so the pump exits without using the grant.
    r.ackSid("a");
    r.ackSid("b", "not-acceptable");
    await Promise.all([bWriting, aWriting, bMore]);
    await settle();
    await a.close();
    await budgetIsWhole(r, 2);
  });

  it("after a stream whose peer never answers is aborted and its blocks time out", async () => {
    const r = receiver();
    r.sender.sendWindowBlocks = 3;
    r.sender.idleTimeoutMs = 20; // ack deadline 20 x window 8
    const a = await open(r, "a");
    r.hold();
    const writing = a.write(payload(64 * 10)).catch((e: unknown) => e);
    await settle();
    expect(r.outstanding("a")).toBe(3);
    await a.abort(new Error("giving up"));
    expect((await writing) as Error).toBeInstanceOf(Error);
    // The three blocks it had out still count until their IQs time out.
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (let i = 0; i < 3; i++) r.ackOne(); // late answers go nowhere
    r.resume();
    await budgetIsWhole(r, 3);
  });
});

describe("a receiver that withholds acks does not hold the session hostage", () => {
  // The budget bounds what waits in the connection's send queue. A block the
  // receiver is deliberately not acking — its consumer is not reading — is
  // not waiting there; counted until its ack it let two stalled streams at
  // the default window (2 x 8 = 16) freeze every other stream on the session
  // until their IQ deadlines, minutes later. Such a block is "parked" once it
  // has waited past max(parkFloorMs, 4 x the measured ack latency), and stops
  // counting. Its stream's own window still holds it.

  it("a sequential reader of three concurrent responses completes", async () => {
    // Found by review: read response 0 only; 1 and 2 sit unread. With parked
    // blocks counted, 1 and 2 held all 16 slots and response 0 got none.
    const [clientSession, serverSession] = createSessionPair();
    const server = new HttpxServer(serverSession, { authorize: allowAll() });
    server.handle(() => ({ status: 200, body: payload(400_000) }));
    server.start();
    const client = new HttpxClient(clientSession, { discover: false });
    cleanups.push(async () => {
      await client.close();
      server.stop();
    });
    const responses = await Promise.all(
      [0, 1, 2].map((i) => client.request("server@example.org", { resource: `/${i}` })),
    );
    await new Promise((resolve) => setTimeout(resolve, 200)); // let 1 and 2 stall
    for (const resp of responses) {
      const body = await Promise.race([
        bytesFromStream(resp.body!),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stalled")), 5_000)),
      ]);
      expect(body).toEqual(payload(400_000));
    }
  });

  it("two backpressured streams leave room for a third", async () => {
    const [a, b] = createSessionPair("sender@example.org/x", "receiver@example.org");
    const tx = IbbManager.acquire(a);
    const rx = IbbManager.acquire(b);
    tx.parkFloorMs = 50;
    cleanups.push(() => {
      tx.release();
      rx.release();
    });
    const incoming = ["p1", "p2", "fast"].map((sid) => rx.expectIncoming("sender@example.org", sid));
    const [p1, p2, fast] = await Promise.all(
      ["p1", "p2", "fast"].map((sid) =>
        tx.openOutgoing("receiver@example.org", { sid, blockSize: 4096, window: 8 }),
      ),
    );
    const [, , fastIn] = await Promise.all(incoming);
    // Nobody reads p1 or p2: their receiver buffers a window, then withholds.
    void p1!.write(payload(4096 * 40)).catch(() => {});
    void p2!.write(payload(4096 * 40)).catch(() => {});
    await settle();
    const reader = fastIn!.readable.getReader();
    const writing = fast!.write(payload(4096 * 4));
    const got = await Promise.race([
      (async () => {
        let n = 0;
        while (n < 4096 * 4) n += (await reader.read()).value?.length ?? 0;
        return n;
      })(),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2_000)),
    ]);
    expect(got).toBe(4096 * 4);
    await writing;
  });

  it("a slow link for everyone keeps its fairness: slow acks are not parked", async () => {
    // The threshold follows the measured ack latency. When every ack is slow
    // — congestion, not a stalled consumer — blocks must keep counting, or
    // the budget would dissolve exactly when it matters.
    const [a, b] = createSessionPair("sender@example.org/x", "receiver@example.org");
    let outstanding = 0;
    let peak = 0;
    b.iqCallee.set(NS_IBB, "open", () => true);
    b.iqCallee.set(NS_IBB, "close", () => true);
    b.iqCallee.set(NS_IBB, "data", async () => {
      outstanding++;
      peak = Math.max(peak, outstanding);
      await new Promise((resolve) => setTimeout(resolve, 60)); // every ack 60 ms
      outstanding--;
      return true;
    });
    const tx = IbbManager.acquire(a);
    tx.sendWindowBlocks = 4;
    tx.parkFloorMs = 20; // well under the ack latency
    cleanups.push(() => tx.release());
    const streams = await Promise.all(
      ["a", "b", "c"].map((sid) => tx.openOutgoing("receiver@example.org", { sid, blockSize: 64 })),
    );
    await Promise.all(
      streams.map(async (s) => {
        await s.write(payload(64 * 12));
        await s.close();
      }),
    );
    // A threshold stuck at the 20 ms floor would park every block and let
    // three windows through; scaled to 4 x 60 ms, the budget holds — from
    // the start, since nothing is parked before the first ack is timed.
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("a parked block that is answered later gives nothing back twice", async () => {
    const r = receiver();
    r.sender.sendWindowBlocks = 3;
    r.sender.parkFloorMs = 30;
    const s = await open(r, "a");
    // One ordinary round trip first: nothing is parked before an ack has
    // been timed, and this test is about what happens once things are.
    await s.write(payload(64));
    await settle();
    r.hold();
    const writing = s.write(payload(64 * 8)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150)); // park, reclaim, repeat
    expect(r.outstanding("a")).toBeGreaterThan(3); // parked blocks let more out
    r.resume();
    await writing;
    await s.close();
    // Were a reclaimed slot released again on its ack, the budget would now
    // be over-full: more than 3 blocks in flight for a fresh stream.
    await settle();
    const fresh = await open(r, "fresh", { window: 64 });
    r.hold();
    const freshWriting = fresh.write(payload(64 * 20)).catch(() => {});
    await settle();
    expect(r.outstanding("fresh")).toBe(3);
    r.resume();
    await freshWriting;
  });
});

describe("through HttpxClient and HttpxServer", () => {
  it("ibbSessionWindow reaches the manager on both sides", async () => {
    const [clientSession, serverSession] = createSessionPair();
    const server = new HttpxServer(serverSession, {
      authorize: allowAll(),
      ibbSessionWindow: 5,
    });
    server.handle(() => ({ status: 200, body: payload(100_000) }));
    server.start();
    const client = new HttpxClient(clientSession, { discover: false, ibbSessionWindow: 7 });
    cleanups.push(async () => {
      await client.close();
      server.stop();
    });
    expect(IbbManager.acquire(serverSession).sendWindowBlocks).toBe(5);
    expect(IbbManager.acquire(clientSession).sendWindowBlocks).toBe(7);
    IbbManager.acquire(serverSession).release();
    IbbManager.acquire(clientSession).release();
    const resp = await client.request("server@example.org");
    expect(await bytesFromStream(resp.body!)).toEqual(payload(100_000));
  });

  it("concurrent responses on one session all complete, byte for byte", async () => {
    const [clientSession, serverSession] = createSessionPair();
    const server = new HttpxServer(serverSession, { authorize: allowAll(), ibbSessionWindow: 4 });
    server.handle((req) => {
      const n = Number(req.resource.slice(1));
      return { status: 200, body: payload(n, n & 0xff) };
    });
    server.start();
    const client = new HttpxClient(clientSession, { discover: false });
    cleanups.push(async () => {
      await client.close();
      server.stop();
    });
    const sizes = [300_000, 9_000, 20_000, 5_000, 150_000, 12_000];
    const bodies = await Promise.all(
      sizes.map(async (n) => {
        const resp = await client.request("server@example.org", { resource: `/${n}` });
        return bytesFromStream(resp.body!);
      }),
    );
    bodies.forEach((body, i) => expect(body).toEqual(payload(sizes[i]!, sizes[i]! & 0xff)));
  });
});
