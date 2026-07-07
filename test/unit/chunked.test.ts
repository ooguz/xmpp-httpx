import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ChunkReassembler } from "../../src/transport/chunked.js";
import { HttpxError } from "../../src/errors.js";
import { encodeBase64 } from "../../src/util/base64.js";
import { bytesFromStream, concatBytes } from "../../src/util/bytes.js";

function chunkOf(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}

describe("ChunkReassembler", () => {
  it("reassembles any permutation of chunks into the original bytes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 0, maxLength: 64 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.infiniteStream(fc.nat()),
        async (parts, randoms) => {
          // Random permutation of chunk indices, Fisher-Yates with fc randoms.
          const order = parts.map((_, i) => i);
          for (let i = order.length - 1; i > 0; i--) {
            const j = randoms.next().value % (i + 1);
            [order[i], order[j]] = [order[j]!, order[i]!];
          }

          const reassembler = new ChunkReassembler({
            streamId: "s",
            idleTimeoutMs: 5_000,
          });
          for (const nr of order) {
            reassembler.push(
              nr,
              nr === parts.length - 1,
              encodeBase64(parts[nr]!),
            );
          }
          const result = await bytesFromStream(reassembler.readable);
          expect(result).toEqual(concatBytes(parts));
        },
      ),
      { numRuns: 50 },
    );
  });

  it("closes on a single empty last chunk (empty body)", async () => {
    const reassembler = new ChunkReassembler({ streamId: "s" });
    reassembler.push(0, true, "");
    expect(await bytesFromStream(reassembler.readable)).toEqual(new Uint8Array(0));
  });

  it("errors on duplicate chunk numbers", async () => {
    const reassembler = new ChunkReassembler({ streamId: "s" });
    reassembler.push(1, false, chunkOf("b"));
    reassembler.push(1, false, chunkOf("b"));
    await expect(bytesFromStream(reassembler.readable)).rejects.toThrow(
      /duplicate chunk/,
    );
  });

  it("errors on chunks after the last one", async () => {
    const reassembler = new ChunkReassembler({ streamId: "s" });
    reassembler.push(1, true, chunkOf("end"));
    reassembler.push(2, false, chunkOf("late"));
    await expect(bytesFromStream(reassembler.readable)).rejects.toThrow(
      /after last/,
    );
  });

  it("errors on invalid base64", async () => {
    const reassembler = new ChunkReassembler({ streamId: "s" });
    reassembler.push(0, false, "not base64 !!!");
    await expect(bytesFromStream(reassembler.readable)).rejects.toThrow(
      /invalid base64/,
    );
  });

  it("errors when the out-of-order buffer overflows", async () => {
    const reassembler = new ChunkReassembler({
      streamId: "s",
      maxBufferedBytes: 100,
    });
    // nr=0 never arrives; everything buffers.
    reassembler.push(1, false, encodeBase64(new Uint8Array(80)));
    reassembler.push(2, false, encodeBase64(new Uint8Array(80)));
    await expect(bytesFromStream(reassembler.readable)).rejects.toThrow(
      /buffer exceeded/,
    );
  });

  it("times out an idle stream", async () => {
    const reassembler = new ChunkReassembler({
      streamId: "s",
      idleTimeoutMs: 30,
    });
    reassembler.push(0, false, chunkOf("start"));
    const err = await bytesFromStream(reassembler.readable).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).code).toBe("timeout");
  });
});
