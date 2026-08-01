import type { Element } from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { NS_JINGLE_S5B } from "../../src/constants.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import type {
  Socks5Adapter,
  Socks5OutStream,
  StreamhostCandidate,
} from "../../src/socks5/protocol.js";
import { createSessionPair } from "../../src/testing/mock-session.js";
import { bytesFromStream, streamFromBytes } from "../../src/util/bytes.js";

/**
 * The XEP-0260 choreography end to end over the in-memory session pair: both
 * sides' stanzas are real, and the bytestream is a fake in-process pipe instead
 * of a socket, so the negotiation is exercised deterministically. The real-socket
 * counterpart lives in test/integration-node/.
 */

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

/**
 * A stand-in for two SOCKS5 adapters that can reach each other: whatever the
 * sender writes for a sid, the receiver reads for that sid.
 */
function fakeNetwork() {
  /** One pipe per (sid, host) pair, so each candidate is its own bytestream. */
  const pipes = new Map<string, TransformStream<Uint8Array, Uint8Array>>();
  const pipeFor = (sid: string, host: string) => {
    const key = `${sid}\u0000${host}`;
    let pipe = pipes.get(key);
    if (!pipe) {
      pipe = new TransformStream<Uint8Array, Uint8Array>();
      pipes.set(key, pipe);
    }
    return pipe;
  };

  /**
   * Lazy on purpose: a duplex hands back both ends, but this fake pipe is
   * one-directional, so only the side that actually writes may lock the
   * writable. Acquiring it eagerly locks out the peer holding the other end.
   */
  const writerFor = (sid: string, host: string): Socks5OutStream => {
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const acquire = () => (writer ??= pipeFor(sid, host).writable.getWriter());
    return {
      write: (chunk) => acquire().write(chunk),
      close: () => acquire().close(),
      abort: (reason) => acquire().abort(reason).catch(() => {}),
    };
  };
  const readerFor = (sid: string, host: string) => pipeFor(sid, host).readable;

  /**
   * One adapter shape for both roles, because the real one is role-neutral too:
   * `openChosen` takes up a connection to a host *we* offered, `connect` dials a
   * host the peer offered, and both hand back the duplex.
   */
  const adapter = (options: {
    candidates?: StreamhostCandidate[];
    failConnect?: boolean;
  }): Socks5Adapter => ({
    candidatesFor: () => Promise.resolve(options.candidates ?? []),
    openChosen: (sid, usedJid, ctx) => {
      const candidate = ctx.candidates.find((entry) => entry.jid === usedJid);
      if (!candidate) return Promise.reject(new Error("not one of ours"));
      return Promise.resolve({
        readable: readerFor(sid, candidate.host),
        out: writerFor(sid, candidate.host),
      });
    },
    connect: (sid, candidates) => {
      if (options.failConnect || candidates.length === 0) {
        return Promise.reject(new Error("no candidate reachable"));
      }
      const candidate = candidates[0]!;
      return Promise.resolve({
        usedJid: candidate.jid,
        readable: readerFor(sid, candidate.host),
        out: writerFor(sid, candidate.host),
      });
    },
    release: () => {},
  });

  const sender = (candidates: StreamhostCandidate[]): Socks5Adapter =>
    adapter({ candidates });
  const receiver = (
    options: { failConnect?: boolean; candidates?: StreamhostCandidate[] } = {},
  ): Socks5Adapter => adapter(options);

  return { sender, receiver, adapter };
}

/** A client/server pair on jingle, with whichever adapters the test wants. */
function setup(options: {
  body: Uint8Array;
  /** Receives the server's own JID, so a self-hosted candidate can claim it. */
  serverAdapter?: (ownJid: string) => Socks5Adapter;
  clientAdapter?: (ownJid: string) => Socks5Adapter;
}) {
  const [clientSession, serverSession] = createSessionPair();
  const ownJid = serverSession.jid.toString();
  const clientJid = clientSession.jid.toString();
  const sent: Element[] = [];
  // Watch what the server puts on the wire, to prove which transport carried it.
  serverSession.deliverHook = (stanza, deliver) => {
    sent.push(stanza);
    queueMicrotask(deliver);
  };

  const server = new HttpxServer(serverSession, {
    authorize: allowAll(),
    preferredStreams: ["jingle"],
    ...(options.serverAdapter ? { socks5: options.serverAdapter(ownJid) } : {}),
  });
  server.handle(() => ({
    status: 200,
    headers: { "content-type": "application/octet-stream" },
    body: streamFromBytes(options.body),
  }));
  server.start();

  const client = new HttpxClient(clientSession, {
    ...(options.clientAdapter ? { socks5: options.clientAdapter(clientJid) } : {}),
  });
  cleanups.push(async () => {
    await client.close();
    server.stop();
  });
  return { client, sent, ownJid, clientJid };
}

const jingleActions = (sent: readonly Element[]): string[] =>
  sent
    .map((stanza) => stanza.getChild("jingle")?.attrs["action"])
    .filter((action): action is string => typeof action === "string");

const hasIbbOpen = (sent: readonly Element[]): boolean =>
  sent.some((stanza) => stanza.getChild("open", "http://jabber.org/protocol/ibb") !== undefined);

describe("jingle s5b (XEP-0260)", () => {
  it("negotiates a candidate and streams the body over it", async () => {
    const body = patternBytes(180_000);
    const network = fakeNetwork();
    const { client, sent } = setup({
      body,
      serverAdapter: (ownJid) =>
        network.sender([{ jid: ownJid, host: "192.0.2.10", port: 5000 }]),
      clientAdapter: () => network.receiver(),
    });

    const response = await client.request("server@example.org", { resource: "/" });
    expect(response.statusCode).toBe(200);
    expect(await bytesFromStream(response.body!)).toEqual(body);

    // The negotiation happened…
    const actions = jingleActions(sent);
    expect(actions).toContain("transport-info");
    expect(actions).toContain("session-terminate");
    // …and the body did NOT go over IBB: the fake pipe is the only other path.
    expect(hasIbbOpen(sent)).toBe(false);
  });

  it("offers candidates in a transport-info, since the initiate cannot carry them", async () => {
    const network = fakeNetwork();
    const { client, sent } = setup({
      body: patternBytes(120_000),
      serverAdapter: (ownJid) =>
        network.sender([{ jid: ownJid, host: "192.0.2.10", port: 5000 }]),
      clientAdapter: () => network.receiver(),
    });
    await bytesFromStream(
      (await client.request("server@example.org", { resource: "/" })).body!,
    );

    const withCandidates = sent.find((stanza) => {
      const transport = stanza
        .getChild("jingle")
        ?.getChild("content")
        ?.getChild("transport", NS_JINGLE_S5B);
      return transport?.getChildren("candidate").length === 1;
    });
    expect(withCandidates).toBeDefined();
    const candidate = withCandidates!
      .getChild("jingle")!
      .getChild("content")!
      .getChild("transport", NS_JINGLE_S5B)!
      .getChild("candidate")!;
    expect(candidate.attrs["host"]).toBe("192.0.2.10");
    expect(candidate.attrs["type"]).toBe("direct");
    // Priority is the §2.1 formula, not an invented number.
    expect(Number(candidate.attrs["priority"])).toBe(126 * 65536);
  });

  it("falls back to IBB when the sender has no candidates to offer", async () => {
    const body = patternBytes(150_000);
    const network = fakeNetwork();
    const { client, sent } = setup({
      body,
      serverAdapter: () => network.sender([]), // nothing to offer
      clientAdapter: () => network.receiver(),
    });

    const response = await client.request("server@example.org", { resource: "/" });
    expect(await bytesFromStream(response.body!)).toEqual(body);

    const actions = jingleActions(sent);
    expect(actions).toContain("transport-replace");
    // And this time the bytes really did travel over IBB.
    expect(hasIbbOpen(sent)).toBe(true);
  });

  it("falls back to IBB when the receiver cannot reach any candidate", async () => {
    const body = patternBytes(90_000);
    const network = fakeNetwork();
    const { client, sent } = setup({
      body,
      serverAdapter: (ownJid) =>
        network.sender([{ jid: ownJid, host: "203.0.113.1", port: 5000 }]),
      clientAdapter: () => network.receiver({ failConnect: true }),
    });

    const response = await client.request("server@example.org", { resource: "/" });
    expect(await bytesFromStream(response.body!)).toEqual(body);
    expect(jingleActions(sent)).toContain("transport-replace");
    expect(hasIbbOpen(sent)).toBe(true);
  });

  it("falls back to IBB for a receiver with no adapter at all", async () => {
    // A browser client: it cannot speak SOCKS5, says candidate-error, and still
    // gets the body.
    const body = patternBytes(70_000);
    const network = fakeNetwork();
    const { client, sent } = setup({
      body,
      serverAdapter: (ownJid) =>
        network.sender([{ jid: ownJid, host: "192.0.2.10", port: 5000 }]),
    });

    const response = await client.request("server@example.org", { resource: "/" });
    expect(await bytesFromStream(response.body!)).toEqual(body);
    expect(jingleActions(sent)).toContain("transport-replace");
    expect(hasIbbOpen(sent)).toBe(true);
  });

  it("still uses plain IBB when neither side has an adapter", async () => {
    const body = patternBytes(60_000);
    const { client, sent } = setup({ body });

    const response = await client.request("server@example.org", { resource: "/" });
    expect(await bytesFromStream(response.body!)).toEqual(body);
    // No s5b at all: the offer went out as an IBB transport in the first place.
    expect(jingleActions(sent)).not.toContain("transport-replace");
    expect(hasIbbOpen(sent)).toBe(true);
  });
});

describe("jingle s5b — the responder's candidate winning", () => {
  it("lets the sender dial out and write when only the receiver can host", async () => {
    // The NAT'd-sender case the connect-and-write direction exists for: the
    // server offers nothing, the client hosts, so the body travels over a socket
    // the *sender* opened.
    const body = patternBytes(130_000);
    const network = fakeNetwork();
    const { client, sent } = setup({
      body,
      serverAdapter: () => network.sender([]),
      clientAdapter: (clientJid) =>
        network.receiver({
          candidates: [{ jid: clientJid, host: "198.51.100.7", port: 6000 }],
        }),
    });

    const response = await client.request("server@example.org", { resource: "/" });
    expect(await bytesFromStream(response.body!)).toEqual(body);
    // No fallback: the negotiation produced a usable candidate.
    expect(jingleActions(sent)).not.toContain("transport-replace");
    expect(hasIbbOpen(sent)).toBe(false);
  });

  it("carries the receiver's candidates in the session-accept", async () => {
    const network = fakeNetwork();
    const { client, sent } = setup({
      body: patternBytes(70_000),
      serverAdapter: () => network.sender([]),
      clientAdapter: (clientJid) =>
        network.receiver({
          candidates: [{ jid: clientJid, host: "198.51.100.7", port: 6000 }],
        }),
    });
    await bytesFromStream(
      (await client.request("server@example.org", { resource: "/" })).body!,
    );

    // The accept is sent by the client, so it is not in `sent` (which watches the
    // server); what proves the round trip is that the server dialled and wrote.
    expect(jingleActions(sent)).toContain("transport-info");
    expect(hasIbbOpen(sent)).toBe(false);
  });

  it("prefers the higher-priority candidate when both sides host", async () => {
    // Both offer a direct candidate, so the tie-break in resolve() decides — and
    // whichever wins, the body must arrive exactly once and never over IBB.
    const body = patternBytes(110_000);
    const network = fakeNetwork();
    const { client, sent } = setup({
      body,
      serverAdapter: (ownJid) =>
        network.sender([{ jid: ownJid, host: "192.0.2.10", port: 5000 }]),
      clientAdapter: (clientJid) =>
        network.receiver({
          candidates: [{ jid: clientJid, host: "198.51.100.7", port: 6000 }],
        }),
    });

    const response = await client.request("server@example.org", { resource: "/" });
    expect(await bytesFromStream(response.body!)).toEqual(body);
    expect(jingleActions(sent)).not.toContain("transport-replace");
    expect(hasIbbOpen(sent)).toBe(false);
  });
});
