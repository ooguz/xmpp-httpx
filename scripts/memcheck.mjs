// Proves IBB streaming uses O(block) memory, not O(body): IBB's per-block IQ
// acks give real end-to-end backpressure (the receiver withholds acks while
// its consumer lags), so peak heap must stay flat as the body grows. Streams
// a large body through the mock session pair sampling heap, and fails if peak
// retained heap scales with body size.
//
// (chunkedBase64 has no protocol acks, so over a backpressure-free mock it
// would queue the whole body — bounded in reality only by the socket and by
// the receiver's maxBufferedBytes cap. IBB is the transport that bounds
// memory by design, so that is what this audit exercises.)
//
// Run: npm run build && node --expose-gc scripts/memcheck.mjs
import { HttpxClient } from "../dist/client/client.js";
import { HttpxServer } from "../dist/server/server.js";
import { allowAll } from "../dist/server/policy.js";
import { bytesFromStream, streamFromBytes } from "../dist/util/bytes.js";

// Minimal mock session pair (mirrors test/integration/mock-session.ts).
import xml from "@xmpp/xml";
import parse from "@xmpp/xml/lib/parse.js";

const NS_STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
let idc = 0;
function makeSession(jid) {
  const routes = [], pending = new Map(), listeners = new Set();
  const s = {
    jid: { toString: () => jid }, peer: null,
    async send(stanza) {
      const out = parse(stanza.toString());
      if (!out.attrs.from) out.attrs.from = jid;
      queueMicrotask(() => s.peer.receive(out));
    },
    iqCaller: {
      request(iq, timeoutMs = 30000) {
        if (!iq.attrs.id) iq.attrs.id = "m" + ++idc;
        const id = iq.attrs.id;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => { pending.delete(id); const e = new Error("timeout"); e.name = "TimeoutError"; reject(e); }, timeoutMs);
          pending.set(id, { resolve, reject, t });
          s.send(iq);
        });
      },
    },
    iqCallee: {
      get: (ns, name, h) => routes.push({ type: "get", ns, name, h }),
      set: (ns, name, h) => routes.push({ type: "set", ns, name, h }),
    },
    on: (e, l) => { if (e === "stanza") listeners.add(l); return s; },
    removeListener: (e, l) => { listeners.delete(l); return s; },
    receive(stanza) {
      for (const l of [...listeners]) l(stanza);
      if (stanza.getName() !== "iq") return;
      const { type, id } = stanza.attrs;
      if (type === "result" || type === "error") {
        const p = pending.get(id); if (!p) return;
        pending.delete(id); clearTimeout(p.t);
        if (type === "error") { const e = new Error("stanza"); e.condition = stanza.getChild("error")?.getChildElements()[0]?.getName() ?? "undefined-condition"; p.reject(e); }
        else p.resolve(stanza);
        return;
      }
      (async () => {
        const child = stanza.getChildElements()[0];
        const r = routes.find((x) => x.type === type && child?.is(x.name, x.ns));
        const reply = (rt, ...k) => xml("iq", { type: rt, to: stanza.attrs.from, from: stanza.attrs.to ?? jid, id }, ...k);
        if (!r) return s.send(reply("error", xml("error", { type: "cancel" }, xml("service-unavailable", { xmlns: NS_STANZAS }))));
        try {
          const res = await r.h({ stanza, element: child, from: { toString: () => stanza.attrs.from }, to: stanza.attrs.to ? { toString: () => stanza.attrs.to } : null, type, id });
          if (res && res.is?.("error")) s.send(reply("error", res));
          else if (res && res.is) s.send(reply("result", res));
          else s.send(reply("result"));
        } catch { s.send(reply("error", xml("error", { type: "cancel" }, xml("internal-server-error", { xmlns: NS_STANZAS })))); }
      })();
    },
  };
  return s;
}

function pair() {
  const a = makeSession("client@example.org/x"), b = makeSession("server@example.org");
  a.peer = b; b.peer = a; return [a, b];
}

// A source stream that produces `size` bytes in fixed blocks without ever
// holding the whole body — the sender must stay O(block).
function producer(size, block = 8192) {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= size) return c.close();
      const n = Math.min(block, size - sent);
      c.enqueue(new Uint8Array(n)); sent += n;
    },
  });
}

async function peakHeapFor(size) {
  const [cs, ss] = pair();
  const server = new HttpxServer(ss, { authorize: allowAll(), preferredStreams: ["ibb"], compress: false });
  server.handle(() => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: producer(size) }));
  server.start();
  const client = new HttpxClient(cs, { discover: false, compress: false });

  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const resp = await client.request("server@example.org", { resource: "/b" });
  // Drain without retaining; sample LIVE heap (post-gc) periodically so we
  // measure retention, not uncollected allocation garbage.
  const reader = resp.body.getReader();
  let total = 0, sinceSample = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    sinceSample += value.length;
    if (sinceSample >= 1024 * 1024) {
      sinceSample = 0;
      globalThis.gc();
      const live = process.memoryUsage().heapUsed;
      if (live > peak) peak = live;
    }
  }
  await client.close(); server.stop();
  if (total !== size) throw new Error(`drained ${total} != ${size}`);
  return peak - before;
}

const small = await peakHeapFor(1 * 1024 * 1024);
const large = await peakHeapFor(16 * 1024 * 1024);
const ratio = large / Math.max(small, 1);
const bodyRatio = 16;

console.log(`1 MiB body:  peak heap delta ≈ ${(small / 1024 / 1024).toFixed(2)} MiB`);
console.log(`16 MiB body: peak heap delta ≈ ${(large / 1024 / 1024).toFixed(2)} MiB`);
console.log(`heap ratio ${ratio.toFixed(2)}x for a ${bodyRatio}x larger body`);

// O(block) means heap stays roughly flat as the body grows; allow slack for
// GC timing and V8 arena growth, but catch true O(body) (would be ~16x).
if (ratio > 3) {
  console.error(`FAIL: heap scaling ${ratio.toFixed(2)}x looks like O(body)`);
  process.exit(1);
}
console.log("MEMCHECK OK — IBB streaming stays ~flat in body size (O(block))");
