import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { DestinationPolicy, DestinationRefused, embeddedV4 } from "../../src/node/destination.js";
import { forwardTarget } from "../../src/node/forward-proxy.js";

function policy(options: ConstructorParameters<typeof DestinationPolicy>[0] = {}) {
  return new DestinationPolicy({ ownAddresses: ["198.51.100.9", "127.0.0.1"], ...options });
}

describe("address classification", () => {
  const refusedAlways = [
    "0.0.0.0", "0.1.2.3", "169.254.169.254", "169.254.0.1", "192.0.0.1", "192.0.2.10",
    "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.5", "224.0.0.1", "239.1.2.3",
    "240.0.0.1", "255.255.255.255", "::", "fe80::1", "fe80::1%eth0", "ff02::1", "2001:db8::1",
    "100::1", "fec0::1", "64:ff9b:1::1", "fd00:ec2::254", "2001::1", "3fff::1",
    "100.100.100.200", // Alibaba metadata, inside the shared space allowPrivate opens
    "::ffff:100.100.100.200",
    // Outside global unicast, embedding nothing this policy reads as IPv4:
    // IPv4-compatible (deprecated) and IPv4-translated forms among them.
    "::7f00:1", "::a00:5", "::127.0.0.1", "::ffff:0:7f00:1", "4000::1", "e000::1",
    // Embedded IPv4 is judged as the IPv4 it stands for.
    "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1",
  ];
  const refusedUnlessPrivate = [
    "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.8.8.8",
    "172.16.0.1", "172.31.255.255", "192.168.0.1", "::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:c0a8:101::1",
  ];
  const publicAddresses = [
    "1.1.1.1", "8.8.8.8", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1",
    "169.253.255.255", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e",
    "64:ff9b::808:808", // NAT64 of 8.8.8.8
  ];

  it.each(refusedAlways)("always refuses %s", (address) => {
    expect(policy().checkAddress(address).allowed).toBe(false);
    expect(policy({ allowPrivate: true }).checkAddress(address).allowed).toBe(false);
  });

  it.each(refusedUnlessPrivate)("refuses %s unless allowPrivate", (address) => {
    expect(policy().checkAddress(address).allowed).toBe(false);
    expect(policy({ allowPrivate: true }).checkAddress(address).allowed).toBe(true);
  });

  it.each(publicAddresses)("allows the public address %s", (address) => {
    expect(policy().checkAddress(address).allowed).toBe(true);
  });

  it("refuses the exit's own public addresses, unless allowPrivate", () => {
    // 8.8.4.77 plays "this exit's public IP": ordinary public space otherwise.
    const p = new DestinationPolicy({ ownAddresses: ["8.8.4.77"] });
    expect(p.checkAddress("8.8.4.77").allowed).toBe(false);
    expect(p.checkAddress("8.8.4.78").allowed).toBe(true);
    const home = new DestinationPolicy({ ownAddresses: ["8.8.4.77"], allowPrivate: true });
    expect(home.checkAddress("8.8.4.77").allowed).toBe(true);
  });

  it("uses this host's interfaces as its own addresses by default", () => {
    // Loopback is always an interface address; the default policy refuses it
    // as its own address and as loopback alike.
    expect(new DestinationPolicy().checkAddress("127.0.0.1").allowed).toBe(false);
  });

  it("refuses what is not an address at all", () => {
    expect(policy().checkAddress("example.org").allowed).toBe(false);
    expect(policy().checkAddress("1.2.3").allowed).toBe(false);
  });
});

describe("embeddedV4", () => {
  it("finds the IPv4 inside mapped, NAT64 and 6to4 addresses", () => {
    expect(embeddedV4("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(embeddedV4("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(embeddedV4("0:0:0:0:0:ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedV4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedV4("64:ff9b::169.254.169.254")).toBe("169.254.169.254");
    expect(embeddedV4("2002:0a00:0001::")).toBe("10.0.0.1");
  });

  it("finds nothing in ordinary IPv6, or in garbage", () => {
    for (const address of ["2606:4700::1111", "::1", "fe80::1", "1:2:3:4:5:6:7:8:9", "::ffff:999.0.0.1", "a::b::c"]) {
      expect(embeddedV4(address), address).toBeUndefined();
    }
  });
});

describe("ports", () => {
  it("allows 80 and 443 by default and nothing else", () => {
    const p = policy();
    expect(p.checkPort(80).allowed).toBe(true);
    expect(p.checkPort(443).allowed).toBe(true);
    for (const port of [22, 25, 8080, 6379, 0]) expect(p.checkPort(port).allowed).toBe(false);
  });

  it("allows exactly the ports it is given", () => {
    const p = policy({ allowPorts: [8080] });
    expect(p.checkPort(8080).allowed).toBe(true);
    expect(p.checkPort(80).allowed).toBe(false);
  });
});

describe("the socket lookup", () => {
  function lookupWith(answers: Record<string, LookupAddress[]>, options = {}) {
    const p = policy({
      ...options,
      resolve: async (host) => {
        const found = answers[host];
        if (!found) throw Object.assign(new Error(`no ${host}`), { code: "ENOTFOUND" });
        return found;
      },
    });
    return (host: string, lookupOptions: object) =>
      new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
        p.lookup(host, lookupOptions as never, ((err: Error | null, address: unknown, family?: number) =>
          resolve({ err, address, ...(family !== undefined ? { family } : {}) })) as never),
      );
  }

  it("answers with the vetted address", async () => {
    const lookup = lookupWith({ "example.org": [{ address: "93.184.215.14", family: 4 }] });
    const single = await lookup("example.org", {});
    expect(single).toEqual({ err: null, address: "93.184.215.14", family: 4 });
    const all = await lookup("example.org", { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  it("refuses a name that resolves to a private address", async () => {
    const lookup = lookupWith({ "evil.example": [{ address: "127.0.0.1", family: 4 }] });
    const { err } = await lookup("evil.example", {});
    expect(err).toBeInstanceOf(DestinationRefused);
  });

  it("does not tell the requester the address, only the operator", async () => {
    // The 403 body is what the requester reads; naming the address would let
    // it map whatever the exit's resolver knows about internal names.
    const lookup = lookupWith({ "intranet.corp": [{ address: "10.20.30.40", family: 4 }] });
    const { err } = await lookup("intranet.corp", {});
    expect(err).toBeInstanceOf(DestinationRefused);
    expect(err!.message).not.toContain("10.20.30.40");
    expect((err as DestinationRefused).detail).toContain("10.20.30.40");
  });

  it("refuses the whole name if any one of its addresses is refused", async () => {
    // Rebinding in one answer: which address the socket tries first is not
    // ours to predict, so one bad address spoils the name.
    const lookup = lookupWith({
      "mixed.example": [
        { address: "93.184.215.14", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });
    expect((await lookup("mixed.example", { all: true })).err).toBeInstanceOf(DestinationRefused);
    expect((await lookup("mixed.example", {})).err).toBeInstanceOf(DestinationRefused);
  });

  it("honours a requested family, and says so when there is none", async () => {
    const lookup = lookupWith({
      "dual.example": [
        { address: "2606:4700::1111", family: 6 },
        { address: "1.1.1.1", family: 4 },
      ],
    });
    expect(await lookup("dual.example", { family: 4 })).toEqual({ err: null, address: "1.1.1.1", family: 4 });
    const v6only = lookupWith({ "v6.example": [{ address: "2606:4700::1111", family: 6 }] });
    const { err } = await v6only("v6.example", { family: 4 });
    expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });

  it("passes resolution failures through", async () => {
    const { err } = await lookupWith({})("nowhere.example", {});
    expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("forwardTarget", () => {
  const req = (resource: string, host?: string) => ({
    resource,
    headers: new Headers(host !== undefined ? { host } : {}),
  });

  it("takes absolute-form, keeping the path exactly as sent", () => {
    const t = forwardTarget(req("http://example.org:8080/a%20b/c?x=1&y=%2F", "ignored.example"));
    expect(typeof t).toBe("object");
    if (typeof t === "string") return;
    expect(t.origin.host).toBe("example.org:8080");
    expect(t.path).toBe("/a%20b/c?x=1&y=%2F");
  });

  it("gives an empty absolute path as /", () => {
    const t = forwardTarget(req("https://example.org"));
    if (typeof t === "string") throw new Error(t);
    expect(t.origin.protocol).toBe("https:");
    expect(t.path).toBe("/");
  });

  it("takes origin-form with a Host header as plain http", () => {
    const t = forwardTarget(req("/index.html?q", "example.org"));
    if (typeof t === "string") throw new Error(t);
    expect(t.origin.href).toBe("http://example.org/");
    expect(t.path).toBe("/index.html?q");
  });

  it("drops the fragment", () => {
    const t = forwardTarget(req("http://example.org/p#frag"));
    if (typeof t === "string") throw new Error(t);
    expect(t.path).toBe("/p");
  });

  it.each(["http://example.org:80/", "https://example.org:443/", "http://example.org:8080/", "http://[2606:4700::1111]:80/", "http://[::1]/"])(
    "takes %s, explicit default ports included",
    (resource) => {
      expect(typeof forwardTarget(req(resource))).toBe("object");
    },
  );

  it.each([
    ["http://example.org:0/", "malformed"],
    ["http://example.org:/", "malformed"],
    ["http://example.org:99999/", "malformed"],
    ["http://1.2.3.256/", "malformed"],
    ["http://1.2.3.4.5/", "malformed"],
    ["http://user:pw@example.org/", "credentials"],
    ["http://ex ample.org/", "malformed"],
    ["http://example.org:80:80/", "malformed"],
    ["ftp://example.org/", "http:// and https://"],
    ["//example.org/", "http:// and https://"],
    ["example.org:443", "http:// and https://"],
  ])("refuses %s", (resource, reason) => {
    const t = forwardTarget(req(resource, "example.org"));
    expect(typeof t).toBe("string");
    expect(t).toContain(reason);
  });

  it.each([undefined, "user@example.org", "example.org/evil", "exa mple.org", "[::1"])(
    "refuses origin-form with Host %s",
    (host) => {
      expect(typeof forwardTarget(req("/x", host))).toBe("string");
    },
  );
});
