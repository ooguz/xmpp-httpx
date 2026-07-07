import { readFileSync } from "node:fs";
import { join } from "node:path";
import xml from "@xmpp/xml";
import parse from "@xmpp/xml/lib/parse.js";
import { describe, expect, it } from "vitest";
import {
  decodeReq,
  decodeResp,
  encodeReq,
  encodeResp,
  type ReqStanza,
  type RespStanza,
} from "../../src/codec/index.js";
import { NS_HTTPX } from "../../src/constants.js";
import { CodecError } from "../../src/errors.js";

function fixture(name: string) {
  const text = readFileSync(
    join(import.meta.dirname, "..", "fixtures", name),
    "utf8",
  );
  return parse(text);
}

describe("codec against XEP-0332 example fixtures", () => {
  it("decodes the GET request (Example: /rdf/xep)", () => {
    const iq = fixture("req-get.xml");
    const req = decodeReq(iq.getChild("req", NS_HTTPX)!);
    expect(req.method).toBe("GET");
    expect(req.resource).toBe("/rdf/xep");
    expect(req.version).toBe("1.1");
    expect(req.headers.get("host")).toBe("example.org");
    // sipub/ibb/jingle default to true when absent
    expect(req.accept).toEqual({ sipub: true, ibb: true, jingle: true });
    expect(req.data).toBeUndefined();
  });

  it("decodes the text response", () => {
    const iq = fixture("resp-text.xml");
    const resp = decodeResp(iq.getChild("resp", NS_HTTPX)!);
    expect(resp.statusCode).toBe(200);
    expect(resp.statusMessage).toBe("OK");
    expect(resp.headers.get("content-type")).toBe("text/turtle");
    expect(resp.data?.kind).toBe("text");
    if (resp.data?.kind === "text") {
      expect(resp.data.text).toContain("dc:title \"HTTP over XMPP\"");
      expect(resp.data.text).toContain("<xep>"); // entities unescaped by parser
    }
  });

  it("decodes the xml (SPARQL) response", () => {
    const iq = fixture("resp-xml.xml");
    const resp = decodeResp(iq.getChild("resp", NS_HTTPX)!);
    expect(resp.data?.kind).toBe("xml");
    if (resp.data?.kind === "xml") {
      expect(resp.data.element.getName()).toBe("sparql");
      expect(resp.data.element.attrs["xmlns"]).toBe(
        "http://www.w3.org/2005/sparql-results#",
      );
    }
  });

  it("decodes the chunkedBase64 response", () => {
    const iq = fixture("resp-chunked.xml");
    const resp = decodeResp(iq.getChild("resp", NS_HTTPX)!);
    expect(resp.data).toEqual({ kind: "chunkedBase64", streamId: "Stream0001" });
  });

  it("decodes the ibb response", () => {
    const iq = fixture("resp-ibb.xml");
    const resp = decodeResp(iq.getChild("resp", NS_HTTPX)!);
    expect(resp.data).toEqual({ kind: "ibb", sid: "Stream0002" });
  });
});

describe("codec round-trips", () => {
  it("round-trips a request through serialize/parse", () => {
    const original: ReqStanza = {
      method: "POST",
      resource: "/api/items?page=2",
      version: "1.1",
      maxChunkSize: 8192,
      accept: { sipub: false, ibb: true, jingle: false },
      headers: new Headers({
        host: "example.org",
        "content-type": "application/json",
      }),
      data: { kind: "text", text: '{"a":1}' },
    };
    const reparsed = decodeReq(parse(encodeReq(original).toString()));
    expect(reparsed.method).toBe("POST");
    expect(reparsed.resource).toBe("/api/items?page=2");
    expect(reparsed.maxChunkSize).toBe(8192);
    expect(reparsed.accept).toEqual({ sipub: false, ibb: true, jingle: false });
    expect(reparsed.headers.get("content-type")).toBe("application/json");
    expect(reparsed.data).toEqual({ kind: "text", text: '{"a":1}' });
  });

  it("round-trips a response with base64 data", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const original: RespStanza = {
      version: "1.1",
      statusCode: 200,
      statusMessage: "OK",
      headers: new Headers({ "content-type": "application/octet-stream" }),
      data: { kind: "base64", bytes },
    };
    const reparsed = decodeResp(parse(encodeResp(original).toString()));
    expect(reparsed.data).toEqual({ kind: "base64", bytes });
  });

  it("clamps maxChunkSize into [256, 65536]", () => {
    const el = encodeReq({
      method: "GET",
      resource: "/",
      version: "1.1",
      maxChunkSize: 5,
      accept: { sipub: true, ibb: true, jingle: true },
      headers: new Headers(),
    });
    expect(el.attrs["maxChunkSize"]).toBe("256");
  });
});

describe("codec error handling", () => {
  it("rejects unknown methods, bad resources, and bad status codes", () => {
    expect(() =>
      decodeReq(xml("req", { xmlns: NS_HTTPX, method: "BREW", resource: "/", version: "1.1" })),
    ).toThrow(CodecError);
    expect(() =>
      decodeReq(xml("req", { xmlns: NS_HTTPX, method: "GET", resource: "no-slash", version: "1.1" })),
    ).toThrow(CodecError);
    expect(() =>
      decodeResp(xml("resp", { xmlns: NS_HTTPX, version: "1.1", statusCode: "abc" })),
    ).toThrow(CodecError);
  });

  it("rejects the wrong element or namespace", () => {
    expect(() => decodeReq(xml("resp", { xmlns: NS_HTTPX }))).toThrow(CodecError);
    expect(() =>
      decodeReq(xml("req", { xmlns: "urn:other", method: "GET", resource: "/", version: "1.1" })),
    ).toThrow(CodecError);
  });

  it("decodes unknown data mechanisms as unsupported", () => {
    const el = parse(
      `<resp xmlns='${NS_HTTPX}' version='1.1' statusCode='200'>` +
        `<data><sipub xmlns='http://jabber.org/protocol/sipub' id='pub1'/></data></resp>`,
    );
    const resp = decodeResp(el);
    expect(resp.data?.kind).toBe("unsupported");
    if (resp.data?.kind === "unsupported") {
      expect(resp.data.name).toBe("sipub");
    }
  });
});
