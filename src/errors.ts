export type HttpxErrorCode =
  | "forbidden"
  | "not-found"
  | "unavailable"
  | "timeout"
  | "protocol-error"
  | "payload-too-large"
  | "not-implemented"
  | "aborted"
  | "stream-error";

const DEFAULT_HTTP_EQUIVALENT: Record<HttpxErrorCode, number> = {
  forbidden: 403,
  "not-found": 404,
  unavailable: 502,
  timeout: 504,
  "protocol-error": 400,
  "payload-too-large": 413,
  "not-implemented": 501,
  aborted: 499,
  "stream-error": 502,
};

/**
 * The error type thrown by this library. XMPP-level failures are mapped to
 * HTTP-equivalent semantics (httpEquivalent) but are never surfaced as fake
 * HttpxResponse objects — only actual <resp> stanzas produce responses.
 */
export class HttpxError extends Error {
  readonly code: HttpxErrorCode;
  readonly httpEquivalent: number;

  constructor(
    code: HttpxErrorCode,
    message: string,
    options?: { httpEquivalent?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = "HttpxError";
    this.code = code;
    this.httpEquivalent = options?.httpEquivalent ?? DEFAULT_HTTP_EQUIVALENT[code];
  }
}

/** Malformed stanza or invalid protocol data. */
export class CodecError extends HttpxError {
  constructor(message: string, cause?: unknown) {
    super("protocol-error", message, cause === undefined ? {} : { cause });
    this.name = "CodecError";
  }
}

/** Stanza error conditions (RFC 6120 §8.3.3) → error codes. */
const CONDITION_MAP: Record<string, { code: HttpxErrorCode; http: number }> = {
  forbidden: { code: "forbidden", http: 403 },
  "not-authorized": { code: "forbidden", http: 403 },
  "not-allowed": { code: "forbidden", http: 403 },
  "registration-required": { code: "forbidden", http: 403 },
  "subscription-required": { code: "forbidden", http: 403 },
  "item-not-found": { code: "not-found", http: 404 },
  "feature-not-implemented": { code: "not-implemented", http: 501 },
  "service-unavailable": { code: "unavailable", http: 502 },
  "recipient-unavailable": { code: "unavailable", http: 502 },
  "remote-server-not-found": { code: "unavailable", http: 502 },
  gone: { code: "unavailable", http: 502 },
  redirect: { code: "unavailable", http: 502 },
  "remote-server-timeout": { code: "timeout", http: 504 },
  "resource-constraint": { code: "payload-too-large", http: 413 },
  "bad-request": { code: "protocol-error", http: 400 },
  "not-acceptable": { code: "protocol-error", http: 406 },
  "unexpected-request": { code: "protocol-error", http: 400 },
  conflict: { code: "protocol-error", http: 409 },
  "policy-violation": { code: "forbidden", http: 403 },
  "internal-server-error": { code: "unavailable", http: 502 },
  "undefined-condition": { code: "unavailable", http: 502 },
};

function hasStringProp<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    key in value &&
    typeof (value as Record<K, unknown>)[key] === "string"
  );
}

/**
 * Maps an error thrown by the XMPP stack (StanzaError with a `condition`,
 * TimeoutError, AbortError, …) to an HttpxError. Already-mapped errors pass
 * through unchanged.
 */
export function fromXmppError(err: unknown): HttpxError {
  if (err instanceof HttpxError) return err;

  if (hasStringProp(err, "condition")) {
    const mapped = CONDITION_MAP[err.condition];
    const message = hasStringProp(err, "text")
      ? `${err.condition}: ${err.text}`
      : err.condition;
    if (mapped) {
      return new HttpxError(mapped.code, message, {
        httpEquivalent: mapped.http,
        cause: err,
      });
    }
    return new HttpxError("unavailable", message, { cause: err });
  }

  if (hasStringProp(err, "name")) {
    if (err.name === "TimeoutError") {
      return new HttpxError("timeout", "request timed out", { cause: err });
    }
    if (err.name === "AbortError") {
      return new HttpxError("aborted", "request aborted", { cause: err });
    }
  }

  return new HttpxError("unavailable", "XMPP transport failure", { cause: err });
}
