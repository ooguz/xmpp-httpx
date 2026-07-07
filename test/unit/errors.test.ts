import { describe, expect, it } from "vitest";
import { fromXmppError, HttpxError } from "../../src/errors.js";

function stanzaError(condition: string): Error {
  const err = new Error(condition) as Error & { condition: string };
  err.name = "StanzaError";
  err.condition = condition;
  return err;
}

describe("fromXmppError", () => {
  it("maps stanza error conditions to HTTP-equivalent semantics", () => {
    expect(fromXmppError(stanzaError("forbidden")).httpEquivalent).toBe(403);
    expect(fromXmppError(stanzaError("item-not-found")).httpEquivalent).toBe(404);
    expect(fromXmppError(stanzaError("service-unavailable")).httpEquivalent).toBe(502);
    expect(fromXmppError(stanzaError("remote-server-timeout")).httpEquivalent).toBe(504);
    expect(fromXmppError(stanzaError("feature-not-implemented")).code).toBe(
      "not-implemented",
    );
  });

  it("maps TimeoutError to 504", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const mapped = fromXmppError(timeout);
    expect(mapped.code).toBe("timeout");
    expect(mapped.httpEquivalent).toBe(504);
  });

  it("passes HttpxError through unchanged", () => {
    const original = new HttpxError("forbidden", "no");
    expect(fromXmppError(original)).toBe(original);
  });

  it("wraps unknown errors as unavailable", () => {
    const mapped = fromXmppError(new Error("socket closed"));
    expect(mapped.code).toBe("unavailable");
    expect(mapped.cause).toBeInstanceOf(Error);
  });
});
