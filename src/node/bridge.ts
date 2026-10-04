import type { Socket } from "node:net";
import type { IbbDuplex } from "../ibb/ibb.js";

/**
 * Pipes a TCP socket and a CONNECT tunnel together, both directions at once,
 * until either side ends. Useful at both ends: a client joins a local
 * application's socket to the tunnel, an exit joins the tunnel to the
 * destination's.
 *
 * - Backpressure both ways. Socket → tunnel: the socket is paused until the
 *   tunnel's write() resolves, which it does only when the IBB window has
 *   room. Tunnel → socket: nothing more is read from the tunnel while the
 *   socket's buffer is over its high-water mark, and the unread tunnel stops
 *   acking — so a slow reader on either side slows the sender on the other,
 *   end to end, instead of filling someone's memory.
 * - No half-close. The tunnel has none, so when the TCP side ends its
 *   sending, the tunnel is closed — after what the socket already sent has
 *   been delivered — and when the tunnel ends, the socket is ended.
 * - Errors on either side tear down both.
 */

export interface BridgeTunnelOptions {
  /** Bytes the socket already delivered before the bridge existed. */
  initial?: Uint8Array;
  onError?: (error: unknown) => void;
}

export function bridgeTunnel(
  socket: Socket,
  tunnel: IbbDuplex,
  options: BridgeTunnelOptions = {},
): Promise<void> {
  // The socket may already be gone by the time the tunnel is handed over (a
  // reset during the stream handshake, a client that vanished): its end/close/
  // error have already fired, so the listeners below would never resolve and
  // this promise would hang, holding the stream open. Wind the tunnel down.
  if (socket.destroyed) {
    void tunnel.abort(new Error("socket closed before the bridge started")).catch(() => {});
    return Promise.resolve();
  }
  let failed = false;
  /** The tunnel ended from the far side; the socket is being wound down. */
  let tunnelEnded = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    options.onError?.(error);
    socket.destroy();
    void tunnel.abort(error instanceof Error ? error : new Error(String(error))).catch(() => {});
  };

  // Socket → tunnel, one write at a time and in order: each chunk waits for
  // the previous write, and the socket is paused while one is pending.
  let writing: Promise<void> = Promise.resolve();
  const send = (chunk: Uint8Array) => {
    // The tunnel is gone from the far side: late bytes have nowhere to go.
    if (tunnelEnded) return;
    socket.pause();
    writing = writing
      .then(() => tunnel.write(chunk))
      .then(
        () => {
          if (!failed) socket.resume();
        },
        (err: unknown) => fail(err),
      );
  };
  socket.on("data", (chunk: Buffer) => send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
  // Callers hand the socket over paused (it must not lose bytes before the
  // bridge exists), and a paused socket does not start flowing just because
  // a data listener appeared.
  if (options.initial && options.initial.length > 0) send(options.initial);
  else socket.resume();

  const upstreamDone = new Promise<void>((resolve) => {
    socket.once("end", () => {
      // The TCP side is done sending. Close the tunnel once what it sent is
      // through; close() waits for every ack.
      void writing
        .then(() => (failed ? undefined : tunnel.close()))
        .then(
          () => resolve(),
          (err: unknown) => {
            fail(err);
            resolve();
          },
        );
    });
    socket.once("close", () => {
      // Closed without an orderly end (reset, destroy): the tunnel goes too.
      if (!socket.readableEnded && !tunnelEnded) fail(new Error("socket closed"));
      resolve();
    });
    socket.once("error", (err) => {
      fail(err);
      resolve();
    });
  });

  // Tunnel → socket.
  const downstreamDone = (async () => {
    const reader = tunnel.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (socket.destroyed) break;
        if (!socket.write(value)) {
          await new Promise<void>((resolve) => {
            const go = () => {
              socket.off("drain", go);
              socket.off("close", go);
              resolve();
            };
            socket.on("drain", go);
            socket.on("close", go);
          });
        }
      }
      // The peer closed the tunnel: our direction is over too. Once what we
      // wrote has left, the socket goes — whatever the TCP peer still sends
      // has nowhere to go, and a peer that never sends FIN would otherwise
      // hold it open.
      tunnelEnded = true;
      if (!socket.destroyed) socket.end(() => socket.destroy());
    } catch (err) {
      fail(err);
    } finally {
      reader.releaseLock();
    }
  })();

  return Promise.all([upstreamDone, downstreamDone]).then(() => undefined);
}
