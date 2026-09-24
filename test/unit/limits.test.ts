import xml, { type Element } from "@xmpp/xml";
import { describe, expect, it } from "vitest";
import {
  applyStreamLimits,
  parseStreamLimits,
  STREAM_LIMITS_NS,
  watchStreamLimits,
  type StanzaBudgets,
} from "../../src/transport/limits.js";
import { stanzaBudgets } from "../../src/transport/select.js";

const FEATURES_NS = "http://etherx.jabber.org/streams";

function features(...children: Element[]): Element {
  return xml("features", { xmlns: FEATURES_NS }, ...children);
}

function limits(maxBytes?: string, idleSeconds?: string): Element {
  return xml(
    "limits",
    { xmlns: STREAM_LIMITS_NS },
    ...(maxBytes !== undefined ? [xml("max-bytes", {}, maxBytes)] : []),
    ...(idleSeconds !== undefined ? [xml("idle-seconds", {}, idleSeconds)] : []),
  );
}

/** The slice of an xmpp.js entity the watcher uses. */
function fakeEntity() {
  const listeners: Array<(element: Element) => void> = [];
  return {
    on(_event: "nonza", listener: (element: Element) => void) {
      listeners.push(listener);
      return this;
    },
    announce(element: Element) {
      for (const listener of listeners) listener(element);
    },
  };
}

describe("parseStreamLimits (XEP-0478)", () => {
  it("reads the spec's example", () => {
    expect(parseStreamLimits(features(limits("10000", "1800")))).toEqual({
      maxBytes: 10000,
      idleSeconds: 1800,
    });
  });

  it("returns what is present, and nothing for a features element without limits", () => {
    expect(parseStreamLimits(features(limits("262144")))).toEqual({ maxBytes: 262144 });
    expect(parseStreamLimits(features(limits(undefined, "60")))).toEqual({ idleSeconds: 60 });
    expect(parseStreamLimits(features(xml("bind", { xmlns: "urn:ietf:params:xml:ns:xmpp-bind" })))).toBeUndefined();
    expect(parseStreamLimits(features(limits()))).toBeUndefined();
  });

  it("ignores a limit that is not a positive integer rather than trusting it", () => {
    for (const bad of ["0", "-1", "1e5", "10 000", "abc", " "]) {
      expect(parseStreamLimits(features(limits(bad))), bad).toBeUndefined();
    }
    // One bad value does not discard a good sibling.
    expect(parseStreamLimits(features(limits("junk", "1800")))).toEqual({ idleSeconds: 1800 });
  });

  it("only looks at stream features, and only at the XEP-0478 namespace", () => {
    expect(parseStreamLimits(xml("iq", { type: "result" }, limits("10000")))).toBeUndefined();
    expect(
      parseStreamLimits(features(xml("limits", { xmlns: "urn:xmpp:other" }, xml("max-bytes", {}, "1")))),
    ).toBeUndefined();
  });
});

describe("watchStreamLimits", () => {
  it("records the latest announcement and reports each one", () => {
    const entity = fakeEntity();
    const seen: number[] = [];
    const watch = watchStreamLimits(entity, (l) => seen.push(l.maxBytes ?? -1));
    expect(watch.current).toBeUndefined();

    entity.announce(features(xml("mechanisms", { xmlns: "urn:ietf:params:xml:ns:xmpp-sasl" })));
    expect(watch.current).toBeUndefined();

    entity.announce(features(limits("10000")));
    entity.announce(xml("message", {}, "not a features element"));
    entity.announce(features(limits("262144", "1800")));
    expect(seen).toEqual([10000, 262144]);
    expect(watch.current).toEqual({ maxBytes: 262144, idleSeconds: 1800 });
  });
});

describe("applyStreamLimits", () => {
  it("applies stanzaBudgets(maxBytes) to the target on every sized announcement", () => {
    const entity = fakeEntity();
    const applied: StanzaBudgets[] = [];
    const target = { setStanzaBudgets: (b: StanzaBudgets) => void applied.push(b) };
    const reported: number[] = [];
    applyStreamLimits(entity, target, (l, b) => reported.push(l.maxBytes!, b.maxChunkSize));

    entity.announce(features(limits(undefined, "1800"))); // no size: nothing to apply
    entity.announce(features(limits("10000")));
    entity.announce(features(limits("262144")));

    expect(applied).toEqual([stanzaBudgets(10000), stanzaBudgets(262144)]);
    expect(reported).toEqual([10000, stanzaBudgets(10000).maxChunkSize, 262144, stanzaBudgets(262144).maxChunkSize]);
  });
});
