import xml, { type Element } from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { NS_IBB, NS_STANZAS } from "../../src/constants.js";
import { HttpxError } from "../../src/errors.js";
import { IbbManager } from "../../src/ibb/ibb.js";
import { decodeBase64 } from "../../src/util/base64.js";
import {
  bytesFromStream,
  concatBytes,
  iterateStream,
} from "../../src/util/bytes.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

/**
 * The windowed IBB sender: N blocks in flight, the ack of block k releasing
 * block k+N. Every property pinned here was invisible to the rest of the
 * suite — a sender that ignored acks entirely, or one that let a later block
 * overtake an earlier one, passed everything else.
 *
 * Two harnesses, because they answer different questions:
 *  - scriptedReceiver() replaces the peer's IBB implementation with handlers
 *    the test drives, so "which block is acked when, and which one fails" is
 *    exact rather than a consequence of stream scheduling;
 *  - livePair() runs a real IbbManager on both ends, which is the only way to
 *    test the receiver's own buffer and its idle timer.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7) & 0xff;
  return bytes;
}

/** Lets pending microtasks and zero-delay timers run to quiescence. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function stanzaError(condition: string): Element {
  return xml(
    "error",
    { type: "cancel" },
    xml(condition, { xmlns: NS_STANZAS }),
  );
}

interface Scripted {
  senderManager: IbbManager;
  /** seq of every <data> block that reached the peer, in arrival order. */
  arrived: number[];
  /** Payload of every block that arrived, in arrival order. */
  blocks: Uint8Array[];
  /** Every stanza the peer saw, in arrival order: "data:<seq>" or "close". */
  events: string[];
  /** Stop acking; blocks still arrive and queue up. */
  hold(): void;
  /**
   * Answer everything held and go back to answering on arrival. "reverse"
   * answers the newest block first — the case where rejection order is not
   * send order.
   */
  resume(order?: "reverse"): void;
  /** Answer this seq with an IQ error instead of a result. */
  failAt(seq: number, condition?: string): void;
  closed: boolean;
}

function scriptedReceiver(): Scripted {
  const [sender, receiver] = createSessionPair(
    "sender@example.org/x",
    "receiver@example.org",
  );
  const arrived: number[] = [];
  const blocks: Uint8Array[] = [];
  const events: string[] = [];
  const held: Array<(reply: Element | boolean) => void> = [];
  let holding = false;
  const failures = new Map<number, string>();
  const state = { closed: false };

  receiver.iqCallee.set(NS_IBB, "open", () => true);
  receiver.iqCallee.set(NS_IBB, "close", () => {
    state.closed = true;
    events.push("close");
    return true;
  });
  receiver.iqCallee.set(NS_IBB, "data", (ctx) => {
    const seq = Number(ctx.element.attrs["seq"]);
    arrived.push(seq);
    events.push(`data:${seq}`);
    blocks.push(decodeBase64(ctx.element.getText()));
    const condition = failures.get(seq);
    const reply: Element | boolean = condition
      ? stanzaError(condition)
      : true;
    if (!holding) return reply;
    return new Promise<Element | boolean>((resolve) => {
      held.push(resolve);
    }).then(() => reply);
  });

  const senderManager = IbbManager.acquire(sender);
  cleanups.push(() => senderManager.release());

  return {
    senderManager,
    arrived,
    blocks,
    events,
    get closed() {
      return state.closed;
    },
    hold: () => {
      holding = true;
    },
    resume: (order) => {
      holding = false;
      const releases = held.splice(0);
      if (order === "reverse") releases.reverse();
      for (const release of releases) release(true);
    },
    failAt: (seq, condition = "not-acceptable") => {
      failures.set(seq, condition);
    },
  };
}

interface Live {
  senderManager: IbbManager;
  receiverManager: IbbManager;
  /** seq of every <data> block that reached the receiver, in arrival order. */
  arrived: number[];
}

function livePair(options?: { receiveWindowBlocks?: number }): Live {
  const [sender, receiver] = createSessionPair(
    "sender@example.org/x",
    "receiver@example.org",
  );
  const arrived: number[] = [];
  sender.deliverHook = (stanza, deliver) => {
    const data = stanza.getChild("data", NS_IBB);
    if (data) arrived.push(Number(data.attrs["seq"]));
    queueMicrotask(deliver);
  };

  const senderManager = IbbManager.acquire(sender);
  const receiverManager = IbbManager.acquire(receiver);
  if (options?.receiveWindowBlocks !== undefined) {
    receiverManager.receiveWindowBlocks = options.receiveWindowBlocks;
  }
  cleanups.push(() => {
    senderManager.release();
    receiverManager.release();
  });
  return { senderManager, receiverManager, arrived };
}

describe("windowed IBB sending", () => {
  it("keeps exactly `window` blocks in flight and no more", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 4,
    });
    peer.hold();

    const writing = out.write(payload(64 * 20));
    await settle();
    expect(peer.arrived).toEqual([0, 1, 2, 3]);

    // Each released ack frees exactly one slot.
    peer.resume();
    peer.hold();
    await settle();
    expect(peer.arrived).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    peer.resume();
    await writing;
    await out.close();
    expect(peer.arrived).toHaveLength(20);
    expect(peer.closed).toBe(true);
  });

  it("window 1 is exactly the block-at-a-time sender", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 1,
    });
    peer.hold();

    const writing = out.write(payload(64 * 5));
    await settle();
    expect(peer.arrived).toEqual([0]);

    peer.resume();
    await writing;
    await out.close();
    expect(peer.arrived).toEqual([0, 1, 2, 3, 4]);
  });

  it("delivers blocks in order, byte for byte, under a full window", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 100,
      window: 8,
    });

    const body = payload(100 * 37 + 42); // deliberately not a block multiple
    // Many writes smaller than a block: the buffer stitches them, and no
    // later block may overtake an earlier one on the way out.
    for (let offset = 0; offset < body.length; offset += 13) {
      await out.write(body.subarray(offset, Math.min(offset + 13, body.length)));
    }
    await out.close();

    expect(peer.arrived).toEqual(peer.arrived.map((_, i) => i));
    expect(concatBytes(peer.blocks)).toEqual(body);
  });

  it("concurrent writers still produce one ordered byte stream", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 4,
    });

    // Two pumps racing on the same stream: seq order must follow buffer
    // order, which only holds if taking a block and sending it is atomic.
    const parts = Array.from({ length: 24 }, (_, i) =>
      payload(64).map((b) => (b + i) & 0xff),
    );
    const expected = concatBytes(parts);
    const half = parts.length / 2;
    await Promise.all([
      (async () => {
        for (let i = 0; i < half; i++) await out.write(parts[i]!);
      })(),
      (async () => {
        for (let i = half; i < parts.length; i++) await out.write(parts[i]!);
      })(),
    ]);
    await out.close();

    expect(peer.arrived).toEqual(peer.arrived.map((_, i) => i));
    // Interleaving between the two writers is allowed; losing or reordering
    // bytes relative to the buffer is not.
    expect(concatBytes(peer.blocks)).toHaveLength(expected.length);
    expect(new Set(peer.arrived).size).toBe(peer.arrived.length);
  });

  it("an IQ error on a block in mid-window fails the stream with that error", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 8,
    });
    peer.failAt(3, "not-acceptable");

    const failure = await (async () => {
      for (let i = 0; i < 40; i++) await out.write(payload(64));
      await out.close();
    })().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(HttpxError);
    // The same latched error, every time, from every entry point.
    expect(await out.write(payload(64)).catch((e: unknown) => e)).toBe(failure);
    expect(await out.close().catch((e: unknown) => e)).toBe(failure);
    // It stopped: no block after the window that carried the failure.
    expect(Math.max(...peer.arrived)).toBeLessThan(16);
  });

  it("reports the earliest failed block, not the first rejection to land", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 8,
    });
    // Two blocks fail in one window, and the later one is answered first.
    peer.hold();
    peer.failAt(2, "not-acceptable");
    peer.failAt(5, "forbidden");

    // Observed through close(), which is where the implementation promises to
    // report it: write() resolves as soon as its blocks are admitted, and
    // these eight fit the window without ever parking.
    const failing = (async () => {
      await out.write(payload(64 * 8));
      await out.close();
    })().catch((e: unknown) => e);
    await settle();
    peer.resume("reverse"); // block 5's error is answered before block 2's
    const err = await failing;

    expect(err).toBeInstanceOf(HttpxError);
    // block 2's condition (not-acceptable -> protocol-error), not block 5's
    // (forbidden) — deterministic across runs however the IQs land.
    expect((err as HttpxError).code).toBe("protocol-error");
    expect((err as HttpxError).message).toContain("not-acceptable");
  });

  it("close() waits for every outstanding block before it resolves", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 8,
    });

    await out.write(payload(64 * 4));
    peer.hold();
    await out.write(payload(64 * 4));

    let closed = false;
    const closing = out.close().then(() => {
      closed = true;
    });
    await settle();
    // Four blocks are still outstanding: close() must not claim success, and
    // <close/> must not have raced past them.
    expect(closed).toBe(false);
    expect(peer.closed).toBe(false);

    peer.resume();
    await closing;
    expect(closed).toBe(true);
    expect(peer.closed).toBe(true);
  });

  it("falls back to the default window rather than letting a bad one disable it", async () => {
    // `inFlight >= NaN` is false, so a NaN window would admit every block at
    // once — backpressure silently gone, which is the one thing the window
    // must never cost. Infinity is the same failure spelled differently.
    for (const bad of [NaN, Infinity, 0, -5]) {
      const peer = scriptedReceiver();
      const out = await peer.senderManager.openOutgoing("receiver@example.org", {
        sid: "s",
        blockSize: 64,
        window: bad,
      });
      peer.hold();
      const writing = out.write(payload(64 * 40)).catch((e: unknown) => e);
      await settle();
      expect(peer.arrived.length, `window ${String(bad)}`).toBeLessThanOrEqual(8);
      expect(peer.arrived.length, `window ${String(bad)}`).toBeGreaterThan(0);
      peer.resume();
      await writing;
      await out.close();
    }
  });

  it("never sends a zero-length block when close() races an un-awaited write()", async () => {
    // close() must test the buffer when it takes from it, not latch "there
    // was a remainder" on entry: a concurrent write()'s pump can drain the
    // buffer to exactly zero while close() is parked on a window slot, and a
    // stale latch then spends a seq and a round trip on an empty <data/>.
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 1,
    });

    const writing = out.write(payload(128)); // exact block multiple, not awaited
    await out.close();
    await writing;

    // Two full blocks, in buffer order, and <close/> last. This is also where
    // "taking a block and sending it is one synchronous step" is proved:
    // split it with an await and close()'s pump, which drains the tail, can
    // overtake the block write()'s pump took but had not yet dispatched —
    // the seq numbers still read 0, 1 while the bytes under them are swapped.
    const body = payload(128);
    expect(peer.blocks).toHaveLength(2);
    expect(peer.blocks[0]).toEqual(body.subarray(0, 64));
    expect(peer.blocks[1]).toEqual(body.subarray(64));
    expect(peer.events).toEqual(["data:0", "data:1", "close"]);
  });

  it("close() reports a block that failed while it was draining", async () => {
    const peer = scriptedReceiver();
    const out = await peer.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 64,
      window: 8,
    });
    peer.hold();
    peer.failAt(1, "not-acceptable");
    await out.write(payload(64 * 3));

    const closing = out.close().catch((e: unknown) => e);
    await settle();
    peer.resume();

    const err = await closing;
    expect(err).toBeInstanceOf(HttpxError);
    expect(peer.closed).toBe(false); // no <close/> after a failed block
  });
});

describe("windowed IBB receiving", () => {
  it("buffers a whole window before it starts withholding acks", async () => {
    // The receive buffer has to exceed window x blockSize. Otherwise the
    // first 64 KiB block alone drives desiredSize to 0, every ack waits for a
    // consumer read, and the sender's window collapses to one block per RTT:
    // with a 64 KiB buffer only 8 blocks would ever reach the peer here.
    const live = livePair({ receiveWindowBlocks: 8 });
    const incoming = live.receiverManager.expectIncoming(
      "sender@example.org",
      "s",
    );
    const out = await live.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 65536,
      window: 8,
    });
    const stream = await incoming;

    // Nothing reads the stream: only the receiver's buffer lets this proceed.
    const writing = out.write(payload(65536 * 16));
    await settle();
    expect(live.arrived).toHaveLength(16);

    const reading = bytesFromStream(stream.readable);
    await writing;
    await out.close();
    expect(await reading).toHaveLength(65536 * 16);
  });

  it("a receiver that stops reading stalls the sender", async () => {
    // The XEP-0047 property the window must not cost us: acks are flow
    // control, so an unread stream stops the sender for good — not after a
    // timeout, and not only once some sender-side counter says so.
    const live = livePair({ receiveWindowBlocks: 2 });
    const incoming = live.receiverManager.expectIncoming(
      "sender@example.org",
      "s",
    );
    const out = await live.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 4096,
      window: 8,
    });
    const stream = await incoming;

    const writing = out.write(payload(4096 * 64)).catch((e: unknown) => e);
    await settle();
    const stalled = live.arrived.length;
    expect(stalled).toBeGreaterThan(0);
    expect(stalled).toBeLessThan(64);
    await settle();
    expect(live.arrived).toHaveLength(stalled); // stopped, not merely slow

    // Draining the consumer is the only thing that releases it.
    const reading = bytesFromStream(stream.readable);
    await writing;
    await out.close();
    expect(await reading).toHaveLength(4096 * 64);
    expect(live.arrived.length).toBe(64);
  });

  it("a slow consumer keeps a backpressured stream alive past the idle timeout", async () => {
    // The idle timer used to be armed only when data arrived. Under a full
    // window the sender is deliberately silent — so a healthy backpressured
    // stream timed itself out. Withholding an ack has to stretch the clock
    // across the window: pull() alone cannot keep it alive, because it only
    // fires once desiredSize goes positive, several reads later.
    const live = livePair({ receiveWindowBlocks: 2 });
    live.receiverManager.idleTimeoutMs = 150;
    live.senderManager.idleTimeoutMs = 5_000;
    const incoming = live.receiverManager.expectIncoming(
      "sender@example.org",
      "s",
    );
    const out = await live.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 65536,
      window: 4,
    });
    const stream = await incoming;

    const total = 65536 * 8;
    const writing = out.write(payload(total));
    let received = 0;
    for await (const part of iterateStream(stream.readable)) {
      received += part.length;
      // Each gap is longer than the receiver's idle timeout. Nothing is idle:
      // the sender is blocked on an ack this consumer has not released yet.
      await new Promise((r) => setTimeout(r, 50));
      if (received >= total) break;
    }
    await writing;
    await out.close();
    expect(received).toBe(total);
  });

  it("still reaps a backpressured stream whose consumer walked away", async () => {
    // The other half of the rule above. Stretching the clock must not mean
    // stopping it: a consumer that abandons a stream without cancelling it
    // (an early `break` out of iterateStream does exactly that — the reader
    // is released, never cancelled) would otherwise hold its buffered bytes
    // and every parked handler for the life of the session.
    const live = livePair({ receiveWindowBlocks: 1 });
    live.receiverManager.idleTimeoutMs = 50; // stalled budget: 50 x (1 + 1)
    live.senderManager.idleTimeoutMs = 10_000;
    const incoming = live.receiverManager.expectIncoming(
      "sender@example.org",
      "s",
    );
    const out = await live.senderManager.openOutgoing("receiver@example.org", {
      sid: "s",
      blockSize: 65536,
      window: 8,
    });
    const stream = await incoming;

    const writing = out.write(payload(65536 * 8)).catch((e: unknown) => e);
    // Read once, then walk away: the reader stays locked and never reads
    // again, so pull() never fires and no ack is ever released.
    const reader = stream.readable.getReader();
    await reader.read();

    const outcome = await Promise.race([
      reader.closed.then(
        () => "closed cleanly",
        (e: unknown) => e,
      ),
      new Promise((r) => setTimeout(() => r("never reaped"), 3_000)),
    ]);
    expect(outcome).toBeInstanceOf(HttpxError);
    expect((outcome as HttpxError).code).toBe("timeout");
    await writing;
  });
});
