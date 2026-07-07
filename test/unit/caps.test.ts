import parse from "@xmpp/xml/lib/parse.js";
import { describe, expect, it } from "vitest";
import {
  buildCapsElement,
  capsVerFromDiscoQuery,
  computeCapsVer,
} from "../../src/caps.js";
import { NS_CAPS } from "../../src/constants.js";

describe("XEP-0115 entity caps", () => {
  it("reproduces the §5.2 worked example hash", async () => {
    // Exodus 0.9.1: one identity, four features → known ver.
    const ver = await computeCapsVer(
      [{ category: "client", type: "pc", name: "Exodus 0.9.1" }],
      [
        "http://jabber.org/protocol/muc",
        "http://jabber.org/protocol/disco#items",
        "http://jabber.org/protocol/disco#info",
        "http://jabber.org/protocol/caps",
      ],
    );
    expect(ver).toBe("QgayPKawpkPSDYmwT/WM94uAlu0=");
  });

  it("is order-independent (sorting is part of the algorithm)", async () => {
    const a = await computeCapsVer(
      [
        { category: "client", type: "pc" },
        { category: "client", type: "web" },
      ],
      ["b", "a"],
    );
    const b = await computeCapsVer(
      [
        { category: "client", type: "web" },
        { category: "client", type: "pc" },
      ],
      ["a", "b"],
    );
    expect(a).toBe(b);
  });

  it("builds a <c/> element", () => {
    const c = buildCapsElement("https://example.org/app", "abc=");
    expect(c.is("c", NS_CAPS)).toBe(true);
    expect(c.attrs["hash"]).toBe("sha-1");
    expect(c.attrs["node"]).toBe("https://example.org/app");
    expect(c.attrs["ver"]).toBe("abc=");
  });

  it("recomputes the ver from a disco#info result", async () => {
    const query = parse(
      `<query xmlns='http://jabber.org/protocol/disco#info'>
         <identity category='client' type='pc' name='Exodus 0.9.1'/>
         <feature var='http://jabber.org/protocol/muc'/>
         <feature var='http://jabber.org/protocol/disco#items'/>
         <feature var='http://jabber.org/protocol/disco#info'/>
         <feature var='http://jabber.org/protocol/caps'/>
       </query>`,
    );
    expect(await capsVerFromDiscoQuery(query)).toBe(
      "QgayPKawpkPSDYmwT/WM94uAlu0=",
    );
  });
});
