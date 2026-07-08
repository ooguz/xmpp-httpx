import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HttpxError } from "../../src/errors.js";
import {
  buildConnectReply,
  buildConnectRequest,
  buildGreeting,
  buildMethodSelection,
  computeDomain,
  parseConnectReply,
  parseConnectRequest,
  parseMethodSelection,
  SOCKS5_METHOD_NO_AUTH,
  SOCKS5_VERSION,
} from "../../src/socks5/protocol.js";

describe("computeDomain", () => {
  it("matches a known SHA-1(sid+requesterJid+targetJid) vector", async () => {
    // Independently computed via Node's crypto module (not this file, which
    // also runs under the browser project and can't import node:crypto):
    //   createHash("sha1").update(sid + requesterJid + targetJid).digest("hex")
    const sid = "vj3hs98y";
    const requesterJid = "romeo@montague.lit/orchard";
    const targetJid = "juliet@capulet.lit/balcony";
    const expected = "972b7bf47291ca609517f67f86b5081086052dad";
    await expect(computeDomain(sid, requesterJid, targetJid)).resolves.toBe(
      expected,
    );
  });

  it("is a 40-character lowercase hex string for arbitrary inputs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), fc.string(), async (a, b, c) => {
        const domain = await computeDomain(a, b, c);
        expect(domain).toMatch(/^[0-9a-f]{40}$/);
      }),
    );
  });
});

describe("greeting / method-selection", () => {
  it("greeting requests version 5, no-auth only", () => {
    const greeting = buildGreeting();
    expect(Array.from(greeting)).toEqual([SOCKS5_VERSION, 1, SOCKS5_METHOD_NO_AUTH]);
  });

  it("method-selection reply round-trips", () => {
    const reply = buildMethodSelection();
    expect(parseMethodSelection(reply)).toEqual({
      version: SOCKS5_VERSION,
      method: SOCKS5_METHOD_NO_AUTH,
    });
  });

  it("rejects a too-short method-selection reply", () => {
    expect(() => parseMethodSelection(new Uint8Array([SOCKS5_VERSION]))).toThrow(
      HttpxError,
    );
  });
});

describe("connect request / reply", () => {
  const hexChar = fc.constantFrom(..."0123456789abcdef".split(""));
  const hexString = (constraints: { minLength: number; maxLength: number }) =>
    fc.array(hexChar, constraints).map((chars) => chars.join(""));

  it("round-trips arbitrary hex domains", () => {
    fc.assert(
      fc.property(hexString({ minLength: 1, maxLength: 255 }), (domain) => {
        const request = buildConnectRequest(domain);
        expect(parseConnectRequest(request)).toEqual({ domain, port: 0 });
      }),
    );
  });

  it("round-trips success and failure replies", () => {
    fc.assert(
      fc.property(
        hexString({ minLength: 1, maxLength: 40 }),
        fc.boolean(),
        (domain, success) => {
          const reply = buildConnectReply(domain, success);
          expect(parseConnectReply(reply)).toEqual({ success });
        },
      ),
    );
  });

  it("rejects a connect request with a non-domain address type", () => {
    // VER CMD RSV ATYP=0x01(IPv4) then 4 address bytes + 2 port bytes.
    const bytes = new Uint8Array([SOCKS5_VERSION, 1, 0, 0x01, 1, 2, 3, 4, 0, 0]);
    expect(() => parseConnectRequest(bytes)).toThrow(HttpxError);
  });

  it("rejects a truncated connect reply", () => {
    expect(() => parseConnectReply(new Uint8Array([SOCKS5_VERSION]))).toThrow(
      HttpxError,
    );
  });

  it("rejects a domain longer than 255 bytes", () => {
    expect(() => buildConnectRequest("a".repeat(256))).toThrow(HttpxError);
  });
});
