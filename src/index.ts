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
  canonicalUrl,
  formatHttpxUrl,
  parseHttpxUrl,
  resolveHttpxUrl,
  resolveUrl,
  resourceForm,
  type HttpxUrl,
  type ResourceForm,
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
  isStreamMechanism,
  type StreamMechanism,
} from "./transport/select.js";
export {
  TransportRegistry,
  type BodyOffer,
  type BodyTransport,
} from "./transport/registry.js";
export { createDefaultRegistry } from "./transport/default-registry.js";
export {
  IbbManager,
  type DuplexOptions,
  type IbbDuplex,
  type IbbIdleTimeout,
  type IbbInStream,
  type IbbOutStream,
} from "./ibb/ibb.js";
export * from "./sipub/index.js";
export * from "./jingle/index.js";
export {
  type Socks5Adapter,
  type StreamhostCandidate,
} from "./socks5/protocol.js";
export {
  buildActivated,
  buildCandidateError,
  buildCandidateUsed,
  buildProxyError,
  buildTransport,
  candidatePriority,
  parseInfo,
  parseTransport,
  resolve as resolveS5bNegotiation,
  s5bDstAddr,
  sortCandidates,
  TYPE_PREFERENCE,
  type CandidateType,
  type S5bCandidate,
  type S5bInfo,
  type S5bOutcome,
  type S5bReport,
  type S5bTransport,
} from "./socks5/jingle-s5b.js";

// Client and server
export * from "./client/index.js";
export * from "./server/index.js";
