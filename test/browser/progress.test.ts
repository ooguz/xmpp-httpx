import { describe, expect, it } from "vitest";
import {
  bufferBody,
  formatBytes,
  formatProgress,
  totalFromHeaders,
  type LoadProgress,
} from "../../examples/webext/src/progress.js";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[i];
      i += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

const bytes = (n: number, fill = 120) => new Uint8Array(n).fill(fill);

function response(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  return new Response(streamOf(chunks), { status: 200, headers });
}

describe("totalFromHeaders", () => {
  it("reads a plain Content-Length", () => {
    expect(totalFromHeaders(new Headers({ "content-length": "1234" }))).toBe(1234);
  });

  it("returns null when absent or unusable", () => {
    expect(totalFromHeaders(new Headers())).toBeNull();
    expect(totalFromHeaders(new Headers({ "content-length": "soon" }))).toBeNull();
    expect(totalFromHeaders(new Headers({ "content-length": "-5" }))).toBeNull();
    expect(totalFromHeaders(new Headers({ "content-length": "1.5" }))).toBeNull();
  });
});

describe("bufferBody", () => {
  it("reports each chunk against the advertised total and returns the body", async () => {
    const reports: LoadProgress[] = [];
    const blob = await bufferBody(
      response([bytes(100), bytes(50)], {
        "content-length": "150",
        "content-type": "text/plain",
      }),
      (p) => reports.push(p),
    );

    expect(reports).toEqual([
      { received: 0, total: 150 },
      { received: 100, total: 150 },
      { received: 150, total: 150 },
    ]);
    expect(blob.size).toBe(150);
    expect(blob.type).toBe("text/plain");
    expect(new Uint8Array(await blob.arrayBuffer())[0]).toBe(120);
  });

  it("reports an unknown total when Content-Length is absent", async () => {
    const reports: LoadProgress[] = [];
    await bufferBody(response([bytes(10)]), (p) => reports.push(p));
    expect(reports).toEqual([
      { received: 0, total: null },
      { received: 10, total: null },
    ]);
  });

  it("drops to an unknown total when the bytes outgrow a lying Content-Length", async () => {
    const reports: LoadProgress[] = [];
    await bufferBody(
      response([bytes(80), bytes(80)], { "content-length": "100" }),
      (p) => reports.push(p),
    );
    expect(reports).toEqual([
      { received: 0, total: 100 },
      { received: 80, total: 100 },
      { received: 160, total: null },
    ]);
  });

  it("works without a callback, and on a bodyless response", async () => {
    const blob = await bufferBody(response([bytes(5)]));
    expect(blob.size).toBe(5);
    const empty = await bufferBody(new Response(null, { status: 200 }));
    expect(empty.size).toBe(0);
  });
});

describe("formatting", () => {
  it("scales bytes to a readable unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3_481)).toBe("3.4 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(1_300_000)).toBe("1.2 MB");
  });

  it("shows 'of total' only when the total is known", () => {
    expect(formatProgress({ received: 1024, total: 4096 })).toBe("1.0 KB of 4.0 KB");
    expect(formatProgress({ received: 1024, total: null })).toBe("1.0 KB");
  });
});
