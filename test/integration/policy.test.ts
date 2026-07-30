import xml from "@xmpp/xml";
import { describe, expect, it, vi } from "vitest";
import {
  allowList,
  manualPolicy,
  presencePolicy,
} from "../../src/server/policy.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

const REQ = { method: "GET", resource: "/", to: "server@example.org" };

describe("authorization policies", () => {
  it("allowList matches bare JIDs, full JIDs, and domain wildcards", () => {
    const policy = allowList(["alice@a.org", "*@b.org", "c.org"]);
    expect(policy("alice@a.org/browser", REQ)).toBe(true);
    expect(policy("mallory@a.org/x", REQ)).toBe(false);
    expect(policy("anyone@b.org/y", REQ)).toBe(true);
    expect(policy("user@c.org", REQ)).toBe(true);
  });

  it("presencePolicy tracks available/unavailable presence", () => {
    const [session] = createSessionPair();
    const policy = presencePolicy(session);

    expect(policy("friend@example.org/home", REQ)).toBe(false);

    session.receive(xml("presence", { from: "friend@example.org/home" }));
    expect(policy("friend@example.org/other-resource", REQ)).toBe(true); // bare-JID match

    session.receive(
      xml("presence", { from: "friend@example.org/home", type: "unavailable" }),
    );
    expect(policy("friend@example.org/home", REQ)).toBe(false);

    // Subscription-management presences are not availability.
    session.receive(
      xml("presence", { from: "stranger@example.org", type: "subscribe" }),
    );
    expect(policy("stranger@example.org", REQ)).toBe(false);

    policy.dispose();
    session.receive(xml("presence", { from: "late@example.org/x" }));
    expect(policy("late@example.org/x", REQ)).toBe(false);
  });

  it("manualPolicy prompts once per JID and caches the decision", async () => {
    const prompt = vi.fn().mockResolvedValue(true);
    const policy = manualPolicy(prompt);

    // Concurrent requests share one pending prompt.
    const [a, b] = await Promise.all([
      policy("guest@example.org/1", REQ),
      policy("guest@example.org/2", REQ),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);

    // Cached within the TTL.
    expect(await policy("guest@example.org/3", REQ)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("manualPolicy re-prompts after the TTL and denies on prompt failure", async () => {
    let answer = true;
    const prompt = vi.fn(() => {
      if (!answer) throw new Error("operator unavailable");
      return answer;
    });
    const policy = manualPolicy(prompt, { ttlMs: 20 });

    expect(await policy("x@example.org", REQ)).toBe(true);
    answer = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(await policy("x@example.org", REQ)).toBe(false); // throw → deny
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});
