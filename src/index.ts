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
export {
  formatHttpxUrl,
  parseHttpxUrl,
  resolveHttpxUrl,
  type HttpxUrl,
} from "./urls.js";
export {
  bareJid,
  jidDomain,
  type IqContext,
  type IqHandler,
  type XmppSession,
} from "./session.js";

// Service discovery + entity capabilities
export {
  advertiseHttpx,
  DEFAULT_IDENTITY,
  DiscoCache,
  httpxFeatures,
  type DiscoSupport,
} from "./discovery.js";
export {
  buildCapsElement,
  capsVerFromDiscoQuery,
  computeCapsVer,
  type CapsIdentity,
} from "./caps.js";

// Transports
export {
  ChunkedSender,
  ChunkReassembler,
  ChunkRouter,
} from "./transport/chunked.js";
export {
  resolveChunkSize,
  selectEncoding,
  stanzaBudgets,
  type BodySource,
  type EncodingDecision,
  type SelectInput,
  type StreamAcceptFlags,
  type StreamMechanism,
} from "./transport/select.js";
export {
  TransportRegistry,
  type BodyOffer,
  type BodyTransport,
} from "./transport/registry.js";
export { createDefaultRegistry } from "./transport/default-registry.js";
export { IbbManager, type IbbInStream, type IbbOutStream } from "./ibb/ibb.js";
export * from "./sipub/index.js";
export * from "./jingle/index.js";

// Client and server
export * from "./client/index.js";
export * from "./server/index.js";
