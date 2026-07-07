import xml from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { buildCapsElement, computeCapsVer } from "../../src/caps.js";
import { NS_DISCO_INFO } from "../../src/constants.js";
import { advertiseHttpx, DiscoCache } from "../../src/discovery.js";
import { createSessionPair } from "./mock-session.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("DiscoCache with entity caps", () => {
  it("verifies a peer-announced ver with one query, then shares the verdict", async () => {
    const [clientSession, serverSession] = createSessionPair();

    // Count disco queries the server actually answers.
    let discoQueries = 0;
    serverSession.on("stanza", (stanza) => {
      if (stanza.getChild("query", NS_DISCO_INFO) && stanza.attrs["type"] === "get") {
        discoQueries++;
      }
    });
    const { identities, features } = advertiseHttpx(serverSession);
    const ver = await computeCapsVer(identities, features);

    const disco = new DiscoCache(clientSession);
    cleanups.push(() => disco.dispose());

    // Two distinct peers announce the same ver via presence.
    for (const from of ["server@example.org/a", "other@example.org/b"]) {
      clientSession.receive(
        xml(
          "presence",
          { from, to: "client@example.org/browser" },
          buildCapsElement("https://example.org/httpx", ver),
        ),
      );
    }

    // First lookup resolves the ver with one real query (mock delivers all
    // IQs to the peer session regardless of 'to').
    expect(await disco.supportsHttpx("server@example.org/a")).toBe("yes");
    expect(discoQueries).toBe(1);

    // Second JID with the same verified ver needs no query at all.
    expect(await disco.supportsHttpx("other@example.org/b")).toBe("yes");
    expect(discoQueries).toBe(1);
  });

  it("drops caps state when a peer goes unavailable", async () => {
    const [clientSession, serverSession] = createSessionPair();
    advertiseHttpx(serverSession);
    const disco = new DiscoCache(clientSession);
    cleanups.push(() => disco.dispose());

    const ver = "bogus-ver=";
    clientSession.receive(
      xml(
        "presence",
        { from: "peer@example.org/x" },
        buildCapsElement("n", ver),
      ),
    );
    clientSession.receive(
      xml("presence", { from: "peer@example.org/x", type: "unavailable" }),
    );

    // Falls back to a plain query (answered by the mock peer's responder);
    // an unverifiable bogus ver must never be trusted.
    expect(await disco.supportsHttpx("peer@example.org/x")).toBe("yes");
  });
});
