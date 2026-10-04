import net from "node:net";
import type { HttpxHandler } from "../server/server.js";
import { bridgeTunnel } from "./bridge.js";
import { DestinationPolicy, DestinationRefused } from "./destination.js";

/**
 * A CONNECT handler for an `HttpxServer` started with `tunnels: true`: dial
 * the destination named in authority-form, and if that works, answer 200 with a tunnel and pipe the
 * two together. Every failure is an ordinary status with no tunnel: 400 for
 * a malformed authority, 403 for destination policy, 502 for refused, reset
 * or unresolvable, 504 for a connect that timed out.
 *
 * The destination policy is the one `createForwardProxyHandler` takes, applied
 * the same way: port and IP literal checked up front, names checked by the
 * socket's own lookup, so the address checked is the address dialled.
 */

export interface ConnectHandlerOptions {
  policy: DestinationPolicy;
  /** Connect deadline. Default 15 s. */
  connectTimeoutMs?: number;
  onTunnelError?: (error: unknown, authority: string) => void;
}

function refuse(status: number, message: string) {
  return { status, statusMessage: message };
}

/** "host:port" or "[v6]:port" → parts. The library has already checked the form. */
export function splitAuthority(authority: string): { host: string; port: number } {
  const colon = authority.lastIndexOf(":");
  return {
    host: authority.slice(0, colon).replace(/^\[(.*)\]$/, "$1"),
    port: Number(authority.slice(colon + 1)),
  };
}

export function createConnectHandler(options: ConnectHandlerOptions): HttpxHandler {
  const { policy } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;

  return async (req) => {
    const { host, port } = splitAuthority(req.resource);
    const portVerdict = policy.checkPort(port);
    if (!portVerdict.allowed) return refuse(403, "Forbidden");
    if (net.isIP(host) !== 0 && !policy.checkAddress(host).allowed) return refuse(403, "Forbidden");

    let socket: net.Socket;
    try {
      socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host, port, lookup: policy.lookup, timeout: connectTimeoutMs });
        s.once("connect", () => {
          s.setTimeout(0); // idle is the tunnel's business, and it has none
          s.off("error", reject);
          resolve(s);
        });
        s.once("timeout", () => s.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })));
        s.once("error", reject);
      });
    } catch (err) {
      options.onTunnelError?.(err, req.resource);
      if (err instanceof DestinationRefused) return refuse(403, "Forbidden");
      if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") return refuse(504, "Gateway Timeout");
      return refuse(502, "Bad Gateway");
    }

    // Until the tunnel is handed over, the socket is ours to close if it
    // never is — the library calls `tunnel` with a dead tunnel in that case.
    // It also has no error listener across that window (the connect one was
    // removed), and a RST arriving while the IBB <open> is in flight would be
    // an uncaught 'error'. Hold a listener until the bridge attaches its own.
    socket.pause();
    socket.on("error", () => {});
    return {
      status: 200,
      tunnel: async (tunnel) => {
        await bridgeTunnel(socket, tunnel, {
          onError: (err) => options.onTunnelError?.(err, req.resource),
        });
      },
    };
  };
}
