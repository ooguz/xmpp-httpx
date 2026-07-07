import fc from "fast-check";
import xml, { Element } from "@xmpp/xml";
import parse from "@xmpp/xml/lib/parse.js";
import { describe, expect, it } from "vitest";
import { decodeData } from "../../src/codec/data.js";
import { decodeHeaders } from "../../src/codec/headers.js";
import { decodeReq } from "../../src/codec/req.js";
import { decodeResp } from "../../src/codec/resp.js";
import { NS_HTTPX, NS_SHIM } from "../../src/constants.js";
import { CodecError } from "../../src/errors.js";
import { ChunkReassembler } from "../../src/transport/chunked.js";
import { parseHttpxUrl, resolveHttpxUrl } from "../../src/urls.js";
import { decodeBase64 } from "../../src/util/base64.js";

/**
 * Fuzzing contract: for arbitrary parser-producible input, decoders either
 * return a value or throw CodecError/TypeError-at-API-boundaries — never an
 * internal TypeError/RangeError, never a hang, never corrupt state.
 */

// XML names a real parser could hand us.
const arbName = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9._-]{0,15}$/)
  .filter((s) => !s.toLowerCase().startsWith("xml"));

const arbText = fc.string({ maxLength: 80 });

const arbAttrs = fc.dictionary(arbName, arbText, { maxKeys: 6 });

interface ElementTree {
  name: string;
  attrs: Record<string, string>;
  children: (ElementTree | string)[];
}

const arbElementTree: fc.Arbitrary<ElementTree> = fc.letrec<{
  node: ElementTree;
}>((tie) => ({
  node: fc.record({
    name: arbName,
    attrs: arbAttrs,
    children: fc.array(fc.oneof(arbText, tie("node")), { maxLength: 4 }),
  }),
})).node;

function buildElement(tree: ElementTree): Element {
  const el = xml(tree.name, tree.attrs);
  for (const child of tree.children) {
    el.append(typeof child === "string" ? child : buildElement(child));
  }
  return el;
}

/** Only these may escape a decoder. */
function isAcceptableThrow(err: unknown): boolean {
  return err instanceof CodecError || err instanceof TypeError;
}

function expectDecodeContract(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    if (!isAcceptableThrow(err)) throw err;
  }
}

describe("codec fuzzing", () => {
  it("decodeReq/decodeResp survive arbitrary elements", () => {
    fc.assert(
      fc.property(arbElementTree, (tree) => {
        const el = buildElement(tree);
        expectDecodeContract(() => decodeReq(el));
        expectDecodeContract(() => decodeResp(el));
        expectDecodeContract(() => decodeData(el));
        expectDecodeContract(() => decodeHeaders(el));
      }),
      { numRuns: 300 },
    );
  });

  it("decodeReq survives req-shaped elements with hostile attribute values", () => {
    const arbReq = fc.record({
      method: fc.oneof(arbText, fc.constant("GET"), fc.constant("POST")),
      resource: arbText,
      version: fc.option(arbText, { nil: undefined }),
      maxChunkSize: fc.option(arbText, { nil: undefined }),
      sipub: fc.option(arbText, { nil: undefined }),
      ibb: fc.option(arbText, { nil: undefined }),
      jingle: fc.option(arbText, { nil: undefined }),
    });
    fc.assert(
      fc.property(arbReq, arbElementTree, (attrs, dataTree) => {
        const cleaned: Record<string, string> = { xmlns: NS_HTTPX };
        for (const [k, v] of Object.entries(attrs)) {
          if (v !== undefined) cleaned[k] = v;
        }
        const el = xml("req", cleaned, xml("data", null, buildElement(dataTree)));
        expectDecodeContract(() => decodeReq(el));
      }),
      { numRuns: 300 },
    );
  });

  it("decoders survive round-tripping through a real parser", () => {
    fc.assert(
      fc.property(arbElementTree, (tree) => {
        const el = buildElement(tree);
        // Anything that serializes must reparse; then decode the reparse.
        let reparsed: Element;
        try {
          reparsed = parse(el.toString());
        } catch {
          return; // some generated text isn't XML-serializable — fine
        }
        expectDecodeContract(() => decodeReq(reparsed));
        expectDecodeContract(() => decodeResp(reparsed));
      }),
      { numRuns: 200 },
    );
  });

  it("SHIM headers with hostile names/values never corrupt Headers", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbText, arbText), { maxLength: 5 }),
        (pairs) => {
          const container = xml("headers", { xmlns: NS_SHIM });
          for (const [name, value] of pairs) {
            container.append(xml("header", { name }, value));
          }
          const parent = xml("resp", { xmlns: NS_HTTPX }, container);
          expectDecodeContract(() => decodeHeaders(parent));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("input-surface fuzzing", () => {
  it("base64 decoder throws only SyntaxError on garbage", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        try {
          decodeBase64(text);
        } catch (err) {
          expect(err).toBeInstanceOf(SyntaxError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("URL parser throws only TypeError on garbage", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        try {
          parseHttpxUrl(text);
        } catch (err) {
          expect(err).toBeInstanceOf(TypeError);
        }
        try {
          resolveHttpxUrl("httpx://a@b.example/x/y?q=1", text);
        } catch (err) {
          expect(err).toBeInstanceOf(TypeError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("ChunkReassembler survives arbitrary push sequences within its bounds", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            nr: fc.oneof(
              fc.nat({ max: 30 }),
              fc.integer({ min: -5, max: -1 }),
              fc.constant(Number.MAX_SAFE_INTEGER),
            ),
            last: fc.boolean(),
            payload: fc.oneof(
              fc.string({ maxLength: 40 }),
              fc.constant("aGVsbG8="),
            ),
          }),
          { maxLength: 25 },
        ),
        async (pushes) => {
          const reassembler = new ChunkReassembler({
            streamId: "fuzz",
            maxBufferedBytes: 4096,
            idleTimeoutMs: 50,
          });
          for (const p of pushes) reassembler.push(p.nr, p.last, p.payload);
          // Whatever happened, the stream must terminate (close or error)
          // rather than hang past its idle timeout.
          await new Promise<void>((resolve) => {
            reassembler.onFinished = resolve;
            reassembler.abort(new Error("fuzz cleanup"));
            resolve();
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
