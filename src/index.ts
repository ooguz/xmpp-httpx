// Protocol constants and shared types
export * from "./constants.js";
export {
  HTTP_METHODS,
  isHttpMethod,
  type HttpMethod,
  type HttpxBodyInit,
  type HttpxRequestInit,
  type StreamAccept,
} from "./types.js";
export {
  CodecError,
  fromXmppError,
  HttpxError,
  type HttpxErrorCode,
} from "./errors.js";

// Stanza codec
export * from "./codec/index.js";

// URLs and session abstraction
export { formatHttpxUrl, parseHttpxUrl, type HttpxUrl } from "./urls.js";
export {
  bareJid,
  jidDomain,
  type IqContext,
  type IqHandler,
  type XmppSession,
} from "./session.js";

// Service discovery
export { advertiseHttpx, DiscoCache, type DiscoSupport } from "./discovery.js";

// Transports
export {
  ChunkedSender,
  ChunkReassembler,
  ChunkRouter,
} from "./transport/chunked.js";
export {
  resolveChunkSize,
  selectEncoding,
  type BodySource,
  type EncodingDecision,
  type SelectInput,
  type StreamMechanism,
} from "./transport/select.js";
export { TransportRegistry, type BodyTransport } from "./transport/registry.js";
export { IbbManager, type IbbInStream, type IbbOutStream } from "./ibb/ibb.js";

// Client and server
export * from "./client/index.js";
export * from "./server/index.js";
