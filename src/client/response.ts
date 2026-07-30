import type { Element } from "@xmpp/xml";
import parse from "@xmpp/xml/lib/parse.js";
import { HttpxError } from "../errors.js";
import { bytesFromStream, textDecoder } from "../util/bytes.js";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The response surface returned by HttpxClient.request(). Mirrors the parts
 * of WHATWG Response that matter, plus xml() (XMPP-native bodies) and a
 * zero-copy bridge to a real Response for browser consumption.
 */
export class HttpxResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly version: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;

  constructor(init: {
    statusCode: number;
    statusMessage?: string;
    version: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  }) {
    this.statusCode = init.statusCode;
    this.statusMessage = init.statusMessage ?? "";
    this.version = init.version;
    this.headers = init.headers;
    this.body = init.body;
  }

  get ok(): boolean {
    return this.statusCode >= 200 && this.statusCode < 300;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.body === null) return new ArrayBuffer(0);
    const bytes = await bytesFromStream(this.body);
    // Return a tightly-sized copy so byteLength matches the body.
    const out = new ArrayBuffer(bytes.length);
    new Uint8Array(out).set(bytes);
    return out;
  }

  async bytes(): Promise<Uint8Array> {
    if (this.body === null) return new Uint8Array(0);
    return bytesFromStream(this.body);
  }

  async text(): Promise<string> {
    return textDecoder.decode(await this.bytes());
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text()) as unknown;
  }

  /**
   * Parses the body as form data. Delegates to the platform's own parser, which
   * handles both `application/x-www-form-urlencoded` and `multipart/form-data`
   * — reimplementing multipart here would be a liability, not a feature.
   */
  async formData(): Promise<FormData> {
    if (!this.headers.has("content-type")) {
      throw new HttpxError(
        "protocol-error",
        "formData() needs a Content-Type on the response",
      );
    }
    // arrayBuffer(), not bytes(): a Uint8Array over a SharedArrayBuffer-capable
    // buffer is not a BodyInit, and this already returns a tight copy.
    const body = await this.arrayBuffer();
    try {
      return await new Response(body, { headers: this.headers }).formData();
    } catch (err) {
      throw new HttpxError("protocol-error", "response body is not form data", {
        cause: err,
      });
    }
  }

  /** Parses the body as a single XML element; null for an empty body. */
  async xml(): Promise<Element | null> {
    const text = (await this.text()).trim();
    if (text === "") return null;
    return parse(text);
  }

  /**
   * Bridges to a real WHATWG Response — new Response(stream) — so browser
   * code (and the future httpx browser) can consume it natively.
   */
  toResponse(): Response {
    if (this.statusCode < 200 || this.statusCode > 599) {
      throw new HttpxError(
        "protocol-error",
        `statusCode ${this.statusCode} cannot be represented as a Response`,
      );
    }
    const body = NULL_BODY_STATUSES.has(this.statusCode) ? null : this.body;
    return new Response(body, {
      status: this.statusCode,
      statusText: this.statusMessage,
      headers: this.headers,
    });
  }
}
