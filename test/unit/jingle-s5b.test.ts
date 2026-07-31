import parse from "@xmpp/xml/lib/parse.js";
import { describe, expect, it } from "vitest";
import { NS_JINGLE_S5B } from "../../src/constants.js";
import { CodecError } from "../../src/errors.js";
import {
  buildActivated,
  buildCandidateError,
  buildCandidateUsed,
  buildProxyError,
  buildTransport,
  candidatePriority,
  parseInfo,
  parseTransport,
  resolve,
  s5bDstAddr,
  sortCandidates,
  TYPE_PREFERENCE,
  type S5bCandidate,
} from "../../src/socks5/jingle-s5b.js";

/** Round-trips through real XML, so nothing survives that a parser would reject. */
const reparse = (element: { toString(): string }) => parse(element.toString());

function candidate(over: Partial<S5bCandidate> = {}): S5bCandidate {
  return {
    cid: "c1",
    jid: "romeo@montague.lit/orchard",
    host: "192.168.4.1",
    port: 5086,
    priority: candidatePriority("direct", 0),
    type: "direct",
    ...over,
  };
}

describe("candidatePriority", () => {
  it("follows §2.1: 2^16 * type-preference + local-preference", () => {
    expect(candidatePriority("direct", 0)).toBe(126 * 65536);
    expect(candidatePriority("direct", 5)).toBe(126 * 65536 + 5);
    expect(candidatePriority("proxy", 0)).toBe(10 * 65536);
  });

  it("orders the types the way the XEP recommends", () => {
    expect(TYPE_PREFERENCE.direct).toBeGreaterThan(TYPE_PREFERENCE.assisted);
    expect(TYPE_PREFERENCE.assisted).toBeGreaterThan(TYPE_PREFERENCE.tunnel);
    expect(TYPE_PREFERENCE.tunnel).toBeGreaterThan(TYPE_PREFERENCE.proxy);
    // A proxy must never outrank a direct candidate, whatever the local part.
    expect(candidatePriority("proxy", 65535)).toBeLessThan(candidatePriority("direct", 0));
  });

  it("refuses a nonsensical local preference", () => {
    expect(() => candidatePriority("direct", -1)).toThrow(RangeError);
    expect(() => candidatePriority("direct", 1.5)).toThrow(RangeError);
  });
});

describe("s5bDstAddr", () => {
  it("is SHA-1 of sid + initiator + responder (§2.2)", async () => {
    // XEP-0260 §2.2's own example.
    const addr = await s5bDstAddr(
      "vj3hs98y",
      "romeo@montague.lit/orchard",
      "juliet@capulet.lit/balcony",
    );
    expect(addr).toMatch(/^[0-9a-f]{40}$/);
    // Order matters: swapping the roles must change the address.
    const swapped = await s5bDstAddr(
      "vj3hs98y",
      "juliet@capulet.lit/balcony",
      "romeo@montague.lit/orchard",
    );
    expect(swapped).not.toBe(addr);
  });
});

describe("transport element", () => {
  it("round-trips candidates through XML", () => {
    const transport = {
      sid: "vj3hs98y",
      mode: "tcp" as const,
      dstaddr: "1a12fb7bc625e55f3ed5b29a53dbe0e4b011592d",
      candidates: [
        candidate({ cid: "hft54dqy", port: 5086, priority: 8257636 }),
        candidate({
          cid: "hutr46fe",
          host: "24.24.24.1",
          port: 5087,
          priority: 8258636,
          type: "proxy",
          jid: "streamer.shakespeare.lit",
        }),
      ],
    };
    const parsed = parseTransport(reparse(buildTransport(transport)));
    expect(parsed).toEqual(transport);
  });

  it("omits dstaddr when there is none, and defaults mode to tcp", () => {
    const element = buildTransport({ sid: "s", mode: "tcp", candidates: [] });
    expect(element.attrs["dstaddr"]).toBeUndefined();

    const noMode = parse(`<transport xmlns='${NS_JINGLE_S5B}' sid='s'/>`);
    expect(parseTransport(noMode).mode).toBe("tcp");
  });

  it("defaults a candidate's type to direct", () => {
    const element = parse(
      `<transport xmlns='${NS_JINGLE_S5B}' sid='s'>` +
        `<candidate cid='c' jid='a@b/c' host='h' port='1' priority='2'/>` +
        `</transport>`,
    );
    expect(parseTransport(element).candidates[0]!.type).toBe("direct");
  });

  it("refuses udp mode rather than silently pretending it is tcp", () => {
    const element = parse(`<transport xmlns='${NS_JINGLE_S5B}' sid='s' mode='udp'/>`);
    expect(() => parseTransport(element)).toThrow(CodecError);
  });

  it("refuses a transport that is not ours", () => {
    expect(() => parseTransport(parse(`<transport xmlns='urn:other' sid='s'/>`))).toThrow(
      CodecError,
    );
    expect(() => parseTransport(parse(`<candidate cid='c'/>`))).toThrow(CodecError);
  });

  it("requires a sid", () => {
    expect(() => parseTransport(parse(`<transport xmlns='${NS_JINGLE_S5B}'/>`))).toThrow(
      CodecError,
    );
  });

  it("rejects candidates a peer could use to confuse us", () => {
    const bad = (attrs: string) =>
      parse(
        `<transport xmlns='${NS_JINGLE_S5B}' sid='s'><candidate ${attrs}/></transport>`,
      );
    // Missing pieces.
    expect(() => parseTransport(bad("jid='a@b/c' host='h' port='1' priority='2'"))).toThrow(
      CodecError,
    );
    expect(() => parseTransport(bad("cid='c' host='h' port='1' priority='2'"))).toThrow(
      CodecError,
    );
    // Nonsense numbers.
    expect(() =>
      parseTransport(bad("cid='c' jid='a@b/c' host='h' port='0' priority='2'")),
    ).toThrow(CodecError);
    expect(() =>
      parseTransport(bad("cid='c' jid='a@b/c' host='h' port='70000' priority='2'")),
    ).toThrow(CodecError);
    expect(() =>
      parseTransport(bad("cid='c' jid='a@b/c' host='h' port='1' priority='-1'")),
    ).toThrow(CodecError);
    // An unknown type would break priority reasoning.
    expect(() =>
      parseTransport(bad("cid='c' jid='a@b/c' host='h' port='1' priority='2' type='psychic'")),
    ).toThrow(CodecError);
  });

  it("rejects duplicate cids, which would make candidate-used ambiguous", () => {
    const element = parse(
      `<transport xmlns='${NS_JINGLE_S5B}' sid='s'>` +
        `<candidate cid='dup' jid='a@b/c' host='h1' port='1' priority='2'/>` +
        `<candidate cid='dup' jid='a@b/c' host='h2' port='2' priority='3'/>` +
        `</transport>`,
    );
    expect(() => parseTransport(element)).toThrow(CodecError);
  });
});

describe("transport-info payloads", () => {
  it("round-trips each kind", () => {
    expect(parseInfo(reparse(buildCandidateUsed("s", "c9")))).toEqual({
      kind: "candidate-used",
      sid: "s",
      cid: "c9",
    });
    expect(parseInfo(reparse(buildCandidateError("s")))).toEqual({
      kind: "candidate-error",
      sid: "s",
    });
    expect(parseInfo(reparse(buildActivated("s", "c9")))).toEqual({
      kind: "activated",
      sid: "s",
      cid: "c9",
    });
    expect(parseInfo(reparse(buildProxyError("s")))).toEqual({
      kind: "proxy-error",
      sid: "s",
    });
  });

  it("refuses an empty or unknown payload", () => {
    expect(() => parseInfo(parse(`<transport xmlns='${NS_JINGLE_S5B}' sid='s'/>`))).toThrow(
      CodecError,
    );
    expect(() =>
      parseInfo(parse(`<transport xmlns='${NS_JINGLE_S5B}' sid='s'><nonsense/></transport>`)),
    ).toThrow(CodecError);
  });

  it("requires a cid on candidate-used and activated", () => {
    expect(() =>
      parseInfo(
        parse(`<transport xmlns='${NS_JINGLE_S5B}' sid='s'><candidate-used/></transport>`),
      ),
    ).toThrow(CodecError);
    expect(() =>
      parseInfo(parse(`<transport xmlns='${NS_JINGLE_S5B}' sid='s'><activated/></transport>`)),
    ).toThrow(CodecError);
  });
});

describe("resolve — completing the negotiation (§2.4)", () => {
  const high = candidate({ cid: "high", priority: candidatePriority("direct", 10) });
  const low = candidate({ cid: "low", priority: candidatePriority("proxy", 0) });

  it("uses the only candidate that worked", () => {
    expect(
      resolve({ local: { kind: "used", candidate: high }, remote: { kind: "error" }, isInitiator: true }),
    ).toEqual({ kind: "use", candidate: high, offeredBy: "remote" });

    expect(
      resolve({ local: { kind: "error" }, remote: { kind: "used", candidate: low }, isInitiator: true }),
    ).toEqual({ kind: "use", candidate: low, offeredBy: "local" });
  });

  it("prefers the higher priority when both sides connected", () => {
    expect(
      resolve({
        local: { kind: "used", candidate: high },
        remote: { kind: "used", candidate: low },
        isInitiator: true,
      }),
    ).toEqual({ kind: "use", candidate: high, offeredBy: "remote" });

    expect(
      resolve({
        local: { kind: "used", candidate: low },
        remote: { kind: "used", candidate: high },
        isInitiator: false,
      }),
    ).toEqual({ kind: "use", candidate: high, offeredBy: "local" });
  });

  it("breaks a tie in favour of the initiator-offered candidate", () => {
    // Both reports name a candidate of equal priority. A side always reports one
    // of the *peer's* candidates, so the initiator-offered one is whatever the
    // responder reported.
    const mine = candidate({ cid: "mine", priority: 100 });
    const theirs = candidate({ cid: "theirs", priority: 100 });

    // As the initiator: the peer (responder) reported ours → ours wins.
    expect(
      resolve({
        local: { kind: "used", candidate: theirs },
        remote: { kind: "used", candidate: mine },
        isInitiator: true,
      }),
    ).toEqual({ kind: "use", candidate: mine, offeredBy: "local" });

    // As the responder: our own report names an initiator-offered candidate.
    expect(
      resolve({
        local: { kind: "used", candidate: theirs },
        remote: { kind: "used", candidate: mine },
        isInitiator: false,
      }),
    ).toEqual({ kind: "use", candidate: theirs, offeredBy: "remote" });
  });

  it("both sides agreeing on a tie pick the same candidate", () => {
    // The property that matters: run the same negotiation from both viewpoints
    // and the winner must be the same candidate, or the transfer deadlocks.
    const initiatorOffered = candidate({ cid: "I", priority: 500 });
    const responderOffered = candidate({ cid: "R", priority: 500 });

    const fromInitiator = resolve({
      local: { kind: "used", candidate: responderOffered },
      remote: { kind: "used", candidate: initiatorOffered },
      isInitiator: true,
    });
    const fromResponder = resolve({
      local: { kind: "used", candidate: initiatorOffered },
      remote: { kind: "used", candidate: responderOffered },
      isInitiator: false,
    });

    expect(fromInitiator.kind).toBe("use");
    expect(fromResponder.kind).toBe("use");
    expect((fromInitiator as { candidate: S5bCandidate }).candidate.cid).toBe(
      (fromResponder as { candidate: S5bCandidate }).candidate.cid,
    );
    expect((fromInitiator as { candidate: S5bCandidate }).candidate.cid).toBe("I");
  });

  it("and on a clear priority difference, too", () => {
    const initiatorOffered = candidate({ cid: "I", priority: 900 });
    const responderOffered = candidate({ cid: "R", priority: 100 });

    const fromInitiator = resolve({
      local: { kind: "used", candidate: responderOffered },
      remote: { kind: "used", candidate: initiatorOffered },
      isInitiator: true,
    });
    const fromResponder = resolve({
      local: { kind: "used", candidate: initiatorOffered },
      remote: { kind: "used", candidate: responderOffered },
      isInitiator: false,
    });
    expect((fromInitiator as { candidate: S5bCandidate }).candidate.cid).toBe("I");
    expect((fromResponder as { candidate: S5bCandidate }).candidate.cid).toBe("I");
  });

  it("falls back when neither side could connect", () => {
    expect(
      resolve({ local: { kind: "error" }, remote: { kind: "error" }, isInitiator: true }),
    ).toEqual({ kind: "fallback" });
  });

  it("says who must activate the winner", () => {
    // A proxy candidate has to be activated by whoever offered it, so the
    // outcome carries that and not just the candidate.
    const proxy = candidate({ cid: "p", type: "proxy", priority: candidatePriority("proxy", 0) });
    const ours = resolve({
      local: { kind: "error" },
      remote: { kind: "used", candidate: proxy },
      isInitiator: true,
    });
    expect(ours).toEqual({ kind: "use", candidate: proxy, offeredBy: "local" });
  });
});

describe("sortCandidates", () => {
  it("puts the best first and is stable across peers", () => {
    const list = [
      candidate({ cid: "b", priority: 100 }),
      candidate({ cid: "a", priority: 100 }),
      candidate({ cid: "z", priority: 900 }),
    ];
    expect(sortCandidates(list).map((c) => c.cid)).toEqual(["z", "a", "b"]);
    // Same input in another order → same result, so both peers try the same one.
    expect(sortCandidates([...list].reverse()).map((c) => c.cid)).toEqual(["z", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const list = [candidate({ cid: "b", priority: 1 }), candidate({ cid: "a", priority: 2 })];
    sortCandidates(list);
    expect(list.map((c) => c.cid)).toEqual(["b", "a"]);
  });
});
