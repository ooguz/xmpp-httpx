import net from "node:net";
import xml from "@xmpp/xml";
import { DEFAULT_SOCKS5_CONNECT_TIMEOUT_MS, NS_BYTESTREAMS } from "../constants.js";
import { fromXmppError, HttpxError } from "../errors.js";
import type { XmppSession } from "../session.js";
import {
  buildConnectReply,
  buildConnectRequest,
  buildGreeting,
  buildMethodSelection,
  computeDomain,
  parseConnectReply,
  parseConnectRequest,
  parseMethodSelection,
  SOCKS5_ATYP_DOMAIN,
  SOCKS5_METHOD_NO_AUTH,
  type Socks5Adapter,
  type Socks5Duplex,
  type Socks5ConnectResult,
  type Socks5NegotiationContext,
  type Socks5OutStream,
  type StreamhostCandidate,
} from "../socks5/protocol.js";
import { concatBytes } from "../util/bytes.js";

/**
 * Node-only XEP-0065 (SOCKS5 Bytestreams) transport, used as an optional
 * stream-method by sipub (see src/sipub/sipub.ts) alongside IBB. Raw TCP
 * sockets mean this can never run in a browser — that's why it lives under
 * the `./node` subpath export rather than the universal entry point.
 *
 * Supports two candidate sources, either or both:
 *  - an external SOCKS5 proxy component (needed for NAT traversal)
 *  - ourselves as a direct streamhost via a local TCP listener
 */

export interface Socks5AdapterOptions {
  /** JID of an external XEP-0065 proxy component (e.g. proxy.example.org). */
  proxyJid?: string;
  /** Skip the proxy address discovery IQ and use this host/port directly. */
  proxyHost?: string;
  proxyPort?: number;
  /** Offer ourselves as a direct streamhost candidate on this address. */
  listen?: { host: string; port: number };
  connectTimeoutMs?: number;
}

/** An accepted inbound socket, plus whatever the handshake over-read with it. */
interface AcceptedSocket {
  socket: net.Socket;
  leftover: Uint8Array;
}

interface PendingDirect {
  promise: Promise<AcceptedSocket>;
  resolve: (accepted: AcceptedSocket) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
}

/** Buffers socket "data" events so callers can await an exact byte count. */
function createSocketReader(socket: net.Socket) {
  let buffer = Buffer.alloc(0);
  const waiters: Array<{
    n: number;
    resolve: (b: Uint8Array) => void;
    reject: (err: Error) => void;
  }> = [];

  function flush(): void {
    while (waiters.length > 0 && buffer.length >= waiters[0]!.n) {
      const { n, resolve } = waiters.shift()!;
      resolve(new Uint8Array(buffer.subarray(0, n)));
      buffer = buffer.subarray(n);
    }
  }

  const fail = (err: Error): void => {
    for (const w of waiters.splice(0)) w.reject(err);
  };

  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  };
  const onError = (err: Error): void => fail(fromXmppError(err));
  const onClose = (): void =>
    fail(new HttpxError("stream-error", "socks5 socket closed unexpectedly"));

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    readExact(n: number): Promise<Uint8Array> {
      return new Promise((resolve, reject) => {
        waiters.push({ n, resolve, reject });
        flush();
      });
    },
    /**
     * Detaches and returns whatever arrived after the bytes the caller asked
     * for. A handshake and the first payload bytes can share a TCP segment, so
     * these have to be handed to the body stream rather than dropped with the
     * reader — losing them silently truncates a body.
     */
    release(): Uint8Array {
      // Pause before detaching. Attaching a "data" listener put the socket into
      // flowing mode, and in flowing mode with no listener Node *discards*
      // incoming bytes — so without this, anything the peer sends between the
      // handshake and the body stream attaching is silently lost. That failure
      // is timing-dependent, which is exactly how it showed up: one run in three.
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      const leftover = new Uint8Array(buffer);
      buffer = Buffer.alloc(0);
      return leftover;
    },
  };
}

async function socks5ClientHandshake(
  socket: net.Socket,
  domain: string,
): Promise<Uint8Array> {
  const reader = createSocketReader(socket);
  socket.write(Buffer.from(buildGreeting()));
  const { method } = parseMethodSelection(await reader.readExact(2));
  if (method !== SOCKS5_METHOD_NO_AUTH) {
    throw new HttpxError(
      "stream-error",
      "socks5 streamhost demands unsupported authentication",
    );
  }
  socket.write(Buffer.from(buildConnectRequest(domain)));
  const head = await reader.readExact(5);
  if (head[3] !== SOCKS5_ATYP_DOMAIN) {
    throw new HttpxError("stream-error", "socks5 reply used an unexpected address type");
  }
  const rest = await reader.readExact(head[4]! + 2);
  const { success } = parseConnectReply(concatBytes([head, rest]));
  if (!success) {
    throw new HttpxError("stream-error", "socks5 streamhost rejected CONNECT");
  }
  return reader.release();
}

async function socks5ServerHandshake(
  socket: net.Socket,
): Promise<{ domain: string; leftover: Uint8Array }> {
  const reader = createSocketReader(socket);
  const greeting = await reader.readExact(2);
  await reader.readExact(greeting[1]!); // offered methods, ignored — no-auth only
  socket.write(Buffer.from(buildMethodSelection()));
  const head = await reader.readExact(5);
  const rest = await reader.readExact(head[4]! + 2);
  const { domain } = parseConnectRequest(concatBytes([head, rest]));
  return { domain, leftover: reader.release() };
}

function readableFromSocket(
  socket: net.Socket,
  prefix?: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix && prefix.length > 0) controller.enqueue(prefix);
      socket.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) socket.pause();
      });
      socket.on("end", () => {
        try {
          controller.close();
        } catch {
          // Already errored/closed.
        }
      });
      socket.on("error", (err) => {
        try {
          controller.error(fromXmppError(err));
        } catch {
          // Already errored/closed.
        }
      });
    },
    pull() {
      socket.resume();
    },
    cancel() {
      socket.destroy();
    },
  });
}

function outStreamFromSocket(socket: net.Socket): Socks5OutStream {
  let failed: Error | undefined;
  return {
    write: (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        if (failed) {
          reject(failed);
          return;
        }
        socket.write(Buffer.from(bytes), (err) => {
          if (err) {
            failed = err;
            reject(err);
          } else {
            resolve();
          }
        });
      }),
    close: () => new Promise<void>((resolve) => socket.end(() => resolve())),
    abort: async (reason: Error) => {
      failed = reason;
      socket.destroy(reason);
    },
  };
}

function connectTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new HttpxError("timeout", `socks5 connect to ${host}:${port} timed out`));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(fromXmppError(err));
    });
  });
}

export function createSocks5Adapter(
  session: XmppSession,
  options: Socks5AdapterOptions = {},
): Socks5Adapter {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_SOCKS5_CONNECT_TIMEOUT_MS;

  let server: net.Server | undefined;
  let boundPort: number | undefined;
  const pendingDirect = new Map<string, PendingDirect>();
  let proxyAddress: { host: string; port: number } | undefined;
  let proxyAddressPromise: Promise<{ host: string; port: number }> | undefined;

  /** Resolves with the actual bound port (listen.port may be 0, meaning
   * "OS picks a free port" — the candidate we advertise must use the real one). */
  function ensureListening(): Promise<number> {
    if (server && boundPort !== undefined) return Promise.resolve(boundPort);
    const listen = options.listen;
    if (!listen) {
      return Promise.reject(
        new HttpxError("protocol-error", "no listen address configured"),
      );
    }
    return new Promise((resolve, reject) => {
      const s = net.createServer((socket) => {
        socks5ServerHandshake(socket)
          .then(({ domain, leftover }) => {
            const pending = pendingDirect.get(domain);
            if (!pending || pending.claimed) {
              socket.write(Buffer.from(buildConnectReply(domain, false)));
              socket.destroy();
              return;
            }
            pending.claimed = true;
            clearTimeout(pending.timer);
            socket.write(Buffer.from(buildConnectReply(domain, true)));
            pending.resolve({ socket, leftover });
          })
          .catch(() => socket.destroy());
      });
      s.once("error", reject);
      s.listen(listen.port, listen.host, () => {
        s.removeListener("error", reject);
        server = s;
        const addr = s.address();
        boundPort = typeof addr === "object" && addr !== null ? addr.port : listen.port;
        resolve(boundPort);
      });
    });
  }

  async function resolveProxyAddress(): Promise<{ host: string; port: number }> {
    if (proxyAddress) return proxyAddress;
    if (options.proxyHost !== undefined && options.proxyPort !== undefined) {
      proxyAddress = { host: options.proxyHost, port: options.proxyPort };
      return proxyAddress;
    }
    const proxyJid = options.proxyJid;
    if (!proxyJid) {
      throw new HttpxError("protocol-error", "no socks5 proxy configured");
    }
    proxyAddressPromise ??= (async () => {
      const reply = await session.iqCaller.request(
        xml(
          "iq",
          { type: "get", to: proxyJid },
          xml("query", { xmlns: NS_BYTESTREAMS }),
        ),
        connectTimeoutMs,
      );
      const streamhost = reply
        .getChild("query", NS_BYTESTREAMS)
        ?.getChild("streamhost");
      const host = streamhost?.attrs["host"];
      const port = Number(streamhost?.attrs["port"]);
      if (!host || !Number.isInteger(port)) {
        throw new HttpxError(
          "protocol-error",
          `socks5 proxy ${proxyJid} did not report a streamhost address`,
        );
      }
      return { host, port };
    })();
    proxyAddress = await proxyAddressPromise;
    return proxyAddress;
  }

  return {
    async candidatesFor(
      sid: string,
      ctx: Socks5NegotiationContext,
    ): Promise<StreamhostCandidate[]> {
      const candidates: StreamhostCandidate[] = [];

      if (options.listen) {
        try {
          const port = await ensureListening();
          const domain = await computeDomain(sid, ctx.requesterJid, ctx.targetJid);
          const ourJid = session.jid?.toString();
          if (ourJid) {
            let resolve!: (accepted: AcceptedSocket) => void;
            let reject!: (err: Error) => void;
            const promise = new Promise<AcceptedSocket>((res, rej) => {
              resolve = res;
              reject = rej;
            });
            const timer = setTimeout(() => {
              const pending = pendingDirect.get(domain);
              if (pending && !pending.claimed) {
                pendingDirect.delete(domain);
                pending.reject(
                  new HttpxError(
                    "timeout",
                    "socks5 target never connected to our direct streamhost",
                  ),
                );
              }
            }, connectTimeoutMs);
            (timer as { unref?: () => void }).unref?.();
            promise.catch(() => {}); // consumed by openChosen; silence unhandled-rejection noise if abandoned
            pendingDirect.set(domain, { promise, resolve, reject, timer, claimed: false });
            candidates.push({
              jid: ourJid,
              host: options.listen.host,
              port,
            });
          }
        } catch {
          // Listener failed to start; proceed without a direct candidate.
        }
      }

      if (options.proxyJid) {
        try {
          const { host, port } = await resolveProxyAddress();
          candidates.push({ jid: options.proxyJid, host, port });
        } catch {
          // Proxy unreachable/misconfigured; proceed without it.
        }
      }

      return candidates;
    },

    async openChosen(
      sid: string,
      usedJid: string,
      ctx: Socks5NegotiationContext & {
        candidates: readonly StreamhostCandidate[];
        activateJid?: string;
      },
    ): Promise<Socks5Duplex> {
      const candidate = ctx.candidates.find((c) => c.jid === usedJid);
      if (!candidate) {
        throw new HttpxError(
          "protocol-error",
          "streamhost-used names a candidate we never offered",
        );
      }
      const domain = await computeDomain(sid, ctx.requesterJid, ctx.targetJid);

      if (candidate.jid === session.jid?.toString()) {
        const pending = pendingDirect.get(domain);
        if (!pending) {
          throw new HttpxError(
            "protocol-error",
            "no pending direct streamhost registration for this sid",
          );
        }
        try {
          const { socket, leftover } = await pending.promise;
          return {
            readable: readableFromSocket(socket, leftover),
            out: outStreamFromSocket(socket),
          };
        } finally {
          pendingDirect.delete(domain);
        }
      }

      const socket = await connectTcp(candidate.host, candidate.port, connectTimeoutMs);
      let leftover: Uint8Array;
      try {
        leftover = await socks5ClientHandshake(socket, domain);
      } catch (err) {
        socket.destroy();
        throw err;
      }
      await session.iqCaller.request(
        xml(
          "iq",
          { type: "set", to: candidate.jid },
          xml(
            "query",
            { xmlns: NS_BYTESTREAMS, sid },
            // Whoever dialled the proxy is the party to activate the stream to;
            // in XEP-0260 that is not always ctx.targetJid.
            xml("activate", null, ctx.activateJid ?? ctx.targetJid),
          ),
        ),
        connectTimeoutMs,
      );
      return {
        readable: readableFromSocket(socket, leftover),
        out: outStreamFromSocket(socket),
      };
    },

    async connect(
      sid: string,
      candidates: readonly StreamhostCandidate[],
      ctx: Socks5NegotiationContext,
    ): Promise<Socks5ConnectResult> {
      const domain = await computeDomain(sid, ctx.requesterJid, ctx.targetJid);
      let lastError: Error = new HttpxError(
        "stream-error",
        "no socks5 streamhost candidates offered",
      );
      for (const candidate of candidates) {
        let socket: net.Socket;
        let dialLeftover: Uint8Array;
        try {
          socket = await connectTcp(candidate.host, candidate.port, connectTimeoutMs);
          dialLeftover = await socks5ClientHandshake(socket, domain);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        return {
          usedJid: candidate.jid,
          readable: readableFromSocket(socket, dialLeftover),
          out: outStreamFromSocket(socket),
        };
      }
      throw lastError;
    },

    release(): void {
      for (const pending of pendingDirect.values()) {
        clearTimeout(pending.timer);
        pending.reject(new HttpxError("aborted", "socks5 adapter closed"));
      }
      pendingDirect.clear();
      server?.close();
      server = undefined;
      boundPort = undefined;
    },
  };
}
