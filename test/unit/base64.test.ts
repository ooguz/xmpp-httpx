import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  base64Length,
  decodeBase64,
  encodeBase64,
} from "../../src/util/base64.js";

describe("base64", () => {
  it("round-trips arbitrary bytes and matches Buffer's encoding", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const encoded = encodeBase64(bytes);
        expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
        expect(decodeBase64(encoded)).toEqual(bytes);
      }),
    );
  });

  it("encodes known vectors", () => {
    expect(encodeBase64(new TextEncoder().encode(""))).toBe("");
    expect(encodeBase64(new TextEncoder().encode("f"))).toBe("Zg==");
    expect(encodeBase64(new TextEncoder().encode("fo"))).toBe("Zm8=");
    expect(encodeBase64(new TextEncoder().encode("foo"))).toBe("Zm9v");
    expect(encodeBase64(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
  });

  it("tolerates whitespace when decoding", () => {
    expect(new TextDecoder().decode(decodeBase64("Zm9v\n  YmFy\r\n"))).toBe(
      "foobar",
    );
  });

  it("rejects invalid characters and truncated input", () => {
    expect(() => decodeBase64("Zm9v!")).toThrow(SyntaxError);
    expect(() => decodeBase64("Z")).toThrow(SyntaxError);
  });

  it("computes encoded lengths", () => {
    expect(base64Length(0)).toBe(0);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
  });
});
