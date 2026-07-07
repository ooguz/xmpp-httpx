import { HttpxError } from "../errors.js";

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function emptyStream(): ReadableStream<Uint8Array> {
  return streamFromBytes(new Uint8Array(0));
}

/**
 * Async iteration over a ReadableStream via getReader() — works on runtimes
 * where ReadableStream is not yet async-iterable (Safari).
 */
export async function* iterateStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function bytesFromStream(
  stream: ReadableStream<Uint8Array>,
  options?: { maxBytes?: number },
): Promise<Uint8Array> {
  const maxBytes = options?.maxBytes ?? Infinity;
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of iterateStream(stream)) {
    total += part.length;
    if (total > maxBytes) {
      await stream.cancel(new HttpxError("payload-too-large", "body too large"));
      throw new HttpxError(
        "payload-too-large",
        `body exceeds ${maxBytes} bytes`,
      );
    }
    parts.push(part);
  }
  return concatBytes(parts);
}

/**
 * Passes bytes through unchanged but errors the stream once more than
 * maxBytes have flowed. Used to enforce request-body caps on streamed bodies.
 */
export function limitStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.length;
        if (total > maxBytes) {
          controller.error(
            new HttpxError("payload-too-large", `body exceeds ${maxBytes} bytes`),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * A ReadableStream whose real source is resolved lazily on first read.
 * Lets us hand out a response object immediately while the body transport
 * (e.g. an incoming IBB stream) is still being negotiated.
 */
export function deferredStream(
  factory: () => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let pending: Promise<ReadableStreamDefaultReader<Uint8Array>> | null = null;

  async function getSourceReader() {
    if (reader) return reader;
    pending ??= factory().then((s) => s.getReader());
    reader = await pending;
    return reader;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const r = await getSourceReader();
      const { done, value } = await r.read();
      if (done) {
        controller.close();
      } else if (value !== undefined) {
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
      try {
        const r = await getSourceReader();
        await r.cancel(reason);
      } catch {
        // Source failed to materialize; nothing to cancel.
      }
    },
  });
}
