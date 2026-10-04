import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { networkInterfaces } from "node:os";

/**
 * Where a forward proxy (an exit) is willing to connect. An exit is an open
 * relay to whoever it admits, so the default is the public internet
 * on ports 80 and 443 and nothing else: no private ranges, no loopback, no
 * link-local (which is where cloud metadata services live), no multicast or
 * reserved space, and none of the exit's own addresses.
 *
 * The check runs *where the connection is made*, on the address actually
 * dialled — as the `lookup` of the socket — not on a name resolved earlier.
 * Resolving first and connecting later is a DNS-rebinding hole: the second
 * resolution can answer differently.
 */

export interface DestinationPolicyOptions {
  /** Ports that may be dialled. Default 80 and 443. */
  allowPorts?: readonly number[];
  /**
   * Also allow private, shared and loopback space, and the exit's own
   * addresses — the home-network use case. Link-local,
   * multicast, reserved and unspecified space stay closed, and so do the
   * cloud metadata endpoints: 169.254.169.254 is link-local anyway, and
   * fd00:ec2::254, which sits inside the ULA range this opens, is closed by
   * name.
   */
  allowPrivate?: boolean;
  /**
   * The exit's own addresses, which are refused even when public — an exit
   * must not become a way to reach services bound to its own public IP.
   * Default: every address of every local interface, read at each check —
   * a host gains addresses while it runs (IPv6 privacy addresses, a rotated
   * prefix, a VPN coming up). A function is likewise called at each check.
   */
  ownAddresses?: readonly string[] | (() => readonly string[]);
  /** Name resolution, for tests. Default node:dns lookup. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

export type Verdict = { allowed: true } | { allowed: false; reason: string };

/** Refused by destination policy; the forward handler answers 403. */
export class DestinationRefused extends Error {
  /** Why, for the operator's log only — it may name an internal address. */
  readonly detail: string;
  constructor(message: string, detail: string = message) {
    super(message);
    this.name = "DestinationRefused";
    this.detail = detail;
  }
}

// IANA IPv4/IPv6 special-purpose registries, split by what --allow-private
// may open. Anything here is never "the public internet".
const PRIVATE_V4 = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // shared address space (CGNAT)
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const;
const ALWAYS_V4 = [
  ["0.0.0.0", 8],
  ["169.254.0.0", 16], // link-local: cloud metadata services
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4], // includes 255.255.255.255
  ["100.100.100.200", 32], // Alibaba Cloud metadata, inside shared space
] as const;
const PRIVATE_V6 = [
  ["::1", 128],
  ["fc00::", 7], // unique local
] as const;
const ALWAYS_V6 = [
  ["::", 128],
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637), inside 2000::/3
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local, deprecated
  ["ff00::", 8], // multicast
  ["fd00:ec2::254", 128], // AWS instance metadata, inside ULA
] as const;

function blockList(v4: ReadonlyArray<readonly [string, number]>, v6: ReadonlyArray<readonly [string, number]>): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
}

const PRIVATE = blockList(PRIVATE_V4, PRIVATE_V6);
const ALWAYS = blockList(ALWAYS_V4, ALWAYS_V6);
/**
 * IPv6 global unicast. An IPv6 address outside it that does not embed an
 * IPv4 one (mapped, NAT64) is not the public internet whatever else it is —
 * IPv4-compatible ::a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d, and whatever
 * the registries assign next — so it is refused rather than listed.
 */
const GLOBAL_V6 = blockList([], [["2000::", 3]]);

/**
 * The IPv4 address an IPv6 address stands for, if it embeds one that routing
 * would reach: IPv4-mapped (::ffff:a.b.c.d), the NAT64 well-known prefix
 * (64:ff9b::/96) and 6to4 (2002:aabb:ccdd::/48). Checking only the IPv6 form
 * would let ::ffff:127.0.0.1 through as "some IPv6 address".
 */
export function embeddedV4(address: string): string | undefined {
  const groups = expandV6(address);
  if (!groups) return undefined;
  const v4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return undefined;
}

/** "::ffff:1.2.3.4" / "fe80::1%eth0" / "2001:db8::1" → eight 16-bit groups. */
function expandV6(address: string): number[] | undefined {
  let text = address.split("%")[0]!.toLowerCase();
  // A trailing dotted quad is two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    if (parts.some((p) => p > 255)) return undefined;
    text =
      text.slice(0, dotted.index) +
      ((parts[0]! << 8) | parts[1]!).toString(16) +
      ":" +
      ((parts[2]! << 8) | parts[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map(
    (g) => parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

function ownInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((info) => info.address);
}

export class DestinationPolicy {
  readonly #ports: ReadonlySet<number>;
  readonly #allowPrivate: boolean;
  readonly #own: () => ReadonlySet<string>;
  readonly #resolve: (hostname: string) => Promise<LookupAddress[]>;

  constructor(options: DestinationPolicyOptions = {}) {
    this.#ports = new Set(options.allowPorts ?? [80, 443]);
    this.#allowPrivate = options.allowPrivate ?? false;
    const own = options.ownAddresses ?? ownInterfaceAddresses;
    if (typeof own === "function") {
      this.#own = () => new Set(own().map(normalize));
    } else {
      const fixed = new Set(own.map(normalize));
      this.#own = () => fixed;
    }
    this.#resolve =
      options.resolve ??
      ((hostname) =>
        new Promise((resolve, reject) =>
          dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) =>
            err ? reject(err) : resolve(addresses),
          ),
        ));
  }

  checkPort(port: number): Verdict {
    return this.#ports.has(port)
      ? { allowed: true }
      : { allowed: false, reason: `port ${port} is not allowed by this exit` };
  }

  /** One concrete address, as it would be dialled. */
  checkAddress(address: string): Verdict {
    const family = isIP(address);
    if (family === 0) return { allowed: false, reason: `not an IP address: ${address}` };
    const v4 = family === 6 ? embeddedV4(address) : undefined;
    const candidates: Array<[string, "ipv4" | "ipv6"]> = [
      [address.split("%")[0]!, family === 4 ? "ipv4" : "ipv6"],
      ...(v4 !== undefined ? ([[v4, "ipv4"]] as Array<[string, "ipv4"]>) : []),
    ];
    // Outside global unicast and embedding no IPv4: refused, unless it is
    // loopback or ULA and private space is open (the lists below decide).
    if (family === 6 && v4 === undefined) {
      const bare = address.split("%")[0]!;
      if (!GLOBAL_V6.check(bare, "ipv6") && !PRIVATE.check(bare, "ipv6")) {
        return { allowed: false, reason: `${address} is not global unicast address space` };
      }
    }
    const own = this.#own();
    for (const [candidate, type] of candidates) {
      if (ALWAYS.check(candidate, type)) {
        return { allowed: false, reason: `${address} is special-purpose address space` };
      }
      if (!this.#allowPrivate && PRIVATE.check(candidate, type)) {
        return { allowed: false, reason: `${address} is private or loopback address space` };
      }
      if (!this.#allowPrivate && own.has(normalize(candidate))) {
        return { allowed: false, reason: `${address} is one of this exit's own addresses` };
      }
    }
    return { allowed: true };
  }

  /**
   * A `lookup` for sockets (http.request, net.connect) that resolves and
   * refuses in one step, so the address checked is the address dialled.
   * Refuses the whole name if *any* of its addresses is refused: a name that
   * answers with both a public and a private address is exactly what a
   * rebinding attack looks like, and there is no telling which the socket
   * would try first.
   */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    const all = typeof options === "object" && options !== null && options.all === true;
    const family = typeof options === "object" && options !== null ? options.family : undefined;
    this.#resolve(hostname).then(
      (addresses) => {
        for (const { address } of addresses) {
          const verdict = this.checkAddress(address);
          if (!verdict.allowed) {
            // Not the address, nor why: the requester would learn what the
            // exit's resolver knows — internal names and their addresses.
            callback(
              new DestinationRefused(`${hostname} is not a destination this exit allows`, verdict.reason),
              "",
              0,
            );
            return;
          }
        }
        const wanted =
          family === 4 || family === 6
            ? addresses.filter((a) => a.family === family)
            : addresses;
        if (wanted.length === 0) {
          const err = Object.assign(new Error(`${hostname} has no usable address`), {
            code: "ENOTFOUND",
          });
          callback(err, "", 0);
          return;
        }
        if (all) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, wanted);
        } else {
          callback(null, wanted[0]!.address, wanted[0]!.family);
        }
      },
      (err: unknown) => callback(err as NodeJS.ErrnoException, "", 0),
    );
  };
}

function normalize(address: string): string {
  return address.split("%")[0]!.toLowerCase();
}
