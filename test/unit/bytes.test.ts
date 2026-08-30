import { describe, expect, it } from "vitest";
import { BlockBuffer, concatBytes } from "../../src/util/bytes.js";

function pattern(length: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7 + seed) & 0xff;
  return bytes;
}

describe("BlockBuffer", () => {
  it("cuts views, not copies, off a part that covers the block", () => {
    // The whole point of the class: a large single-part body must never be
    // re-copied per block (the naive concat-per-block loop is O(body²)).
    // Sharing the pushed part's backing buffer is the observable proof.
    const buf = new BlockBuffer();
    const big = pattern(64 * 1024);
    buf.push(big);
    let offset = 0;
    while (buf.size >= 4096) {
      const block = buf.take(4096);
      expect(block.buffer).toBe(big.buffer);
      expect(block).toEqual(big.subarray(offset, offset + 4096));
      offset += 4096;
    }
    expect(buf.size).toBe(0);
  });

  it("coalesces only when the front part cannot cover one block", () => {
    const buf = new BlockBuffer();
    const a = pattern(3, 1);
    const b = pattern(10, 2);
    buf.push(a);
    buf.push(b);
    const block = buf.take(8);
    expect(block).toEqual(concatBytes([a, b]).subarray(0, 8));
    // After the one coalesce, the remainder is viewed, not re-copied.
    const rest = buf.take(5);
    expect(rest.buffer).toBe(block.buffer);
    expect(rest).toEqual(b.subarray(5));
    expect(buf.size).toBe(0);
  });

  it("reassembles pushed parts exactly, across arbitrary boundaries", () => {
    const parts = [pattern(1, 3), pattern(4096, 4), pattern(7, 5), pattern(9000, 6)];
    const buf = new BlockBuffer();
    for (const p of parts) buf.push(p);
    const out: Uint8Array[] = [];
    while (buf.size >= 512) out.push(buf.take(512));
    out.push(buf.drain());
    expect(concatBytes(out)).toEqual(concatBytes(parts));
    expect(buf.size).toBe(0);
  });

  it("ignores empty parts and drains an empty buffer to an empty array", () => {
    const buf = new BlockBuffer();
    buf.push(new Uint8Array(0));
    expect(buf.size).toBe(0);
    expect(buf.drain()).toEqual(new Uint8Array(0));
  });

  it("refuses to take more than is buffered, and non-positive counts", () => {
    const buf = new BlockBuffer();
    buf.push(pattern(10));
    expect(() => buf.take(11)).toThrow(RangeError);
    expect(() => buf.take(0)).toThrow(RangeError);
    // The refusal must not have consumed anything.
    expect(buf.size).toBe(10);
    expect(buf.take(10)).toEqual(pattern(10));
  });

  it("refuses a fractional take instead of desyncing its byte count", () => {
    // subarray() truncates 3.5 to 3 while `#bytes -= 3.5` would not — the
    // drift makes size read 0 with a real byte still buffered, which turned
    // into silent wire truncation at IBB close() before this guard.
    const buf = new BlockBuffer();
    buf.push(pattern(7));
    expect(() => buf.take(3.5)).toThrow(RangeError);
    expect(buf.size).toBe(7);
    expect(buf.take(7)).toEqual(pattern(7));
  });

  it("keeps accepting pushes after drain()", () => {
    const buf = new BlockBuffer();
    buf.push(pattern(5, 7));
    expect(buf.drain()).toEqual(pattern(5, 7));
    buf.push(pattern(6, 8));
    expect(buf.size).toBe(6);
    expect(buf.take(6)).toEqual(pattern(6, 8));
  });
});
