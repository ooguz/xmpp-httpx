import type { Element } from "@xmpp/xml";
import { stanzaBudgets } from "./select.js";

/**
 * XEP-0478 Stream Limits Advertisement (v0.2.0, Experimental): a server
 * announces, in its <stream:features/>, the largest first-level element it
 * accepts and how long a stream may stay silent. The size is what
 * `stanzaBudgets()` wants and was fed by hand before this.
 */
export const STREAM_LIMITS_NS = "urn:xmpp:stream-limits:0";
const STREAM_FEATURES_NS = "http://etherx.jabber.org/streams";

export interface StreamLimits {
  /** Largest first-level stream element (stanzas included), in bytes. */
  maxBytes?: number;
  /** Seconds without traffic after which the server may probe or drop us. */
  idleSeconds?: number;
}

/** What `stanzaBudgets()` returns and `setStanzaBudgets()` takes. */
export type StanzaBudgets = ReturnType<typeof stanzaBudgets>;

/** An HttpxClient or HttpxServer — anything whose sizes a stream limit bounds. */
export interface StanzaBudgetTarget {
  setStanzaBudgets(budgets: StanzaBudgets): void;
}

/** The part of an xmpp.js entity (or anything like it) the watcher needs. */
export interface NonzaSource {
  on(event: "nonza", listener: (element: Element) => void): unknown;
}

export interface StreamLimitsWatch {
  /** The limits last advertised on this stream; undefined until one arrives. */
  readonly current: StreamLimits | undefined;
}

// A limit that is not a positive integer is ignored, never trusted: "0",
// "-1", "1e5" or "10 000" would each turn into a budget nobody meant.
function positiveInteger(text: string | null): number | undefined {
  if (text === null) return undefined;
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The limits a <stream:features/> element advertises, or undefined when it is
 * not a features element, carries no <limits/>, or carries none usable.
 */
export function parseStreamLimits(features: Element): StreamLimits | undefined {
  if (!features.is("features", STREAM_FEATURES_NS)) return undefined;
  const limits = features.getChild("limits", STREAM_LIMITS_NS);
  if (!limits) return undefined;
  const maxBytes = positiveInteger(limits.getChildText("max-bytes", STREAM_LIMITS_NS));
  const idleSeconds = positiveInteger(limits.getChildText("idle-seconds", STREAM_LIMITS_NS));
  if (maxBytes === undefined && idleSeconds === undefined) return undefined;
  return {
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(idleSeconds !== undefined ? { idleSeconds } : {}),
  };
}

/**
 * Watches a stream for XEP-0478 limits. Install it before `entity.start()`:
 * the features that carry them arrive before resource binding, so a listener
 * added once `start()` has resolved has already missed them. Limits may be
 * announced more than once — before and after authentication, and again on
 * every reconnect — and `onLimits` runs each time.
 */
export function watchStreamLimits(
  entity: NonzaSource,
  onLimits?: (limits: StreamLimits) => void,
): StreamLimitsWatch {
  let current: StreamLimits | undefined;
  entity.on("nonza", (element) => {
    const limits = parseStreamLimits(element);
    if (!limits) return;
    current = limits;
    onLimits?.(limits);
  });
  return {
    get current() {
      return current;
    },
  };
}

/**
 * Keeps a client's or server's budgets in step with the stream's advertised
 * limit: each time the server announces a size, `stanzaBudgets(maxBytes)` is
 * applied to `target`. An announcement without a size changes nothing.
 * `onApplied` is for the log line an operator wants to see.
 */
export function applyStreamLimits(
  entity: NonzaSource,
  target: StanzaBudgetTarget,
  onApplied?: (limits: StreamLimits, budgets: StanzaBudgets) => void,
): StreamLimitsWatch {
  return watchStreamLimits(entity, (limits) => {
    if (limits.maxBytes === undefined) return;
    const budgets = stanzaBudgets(limits.maxBytes);
    target.setStanzaBudgets(budgets);
    onApplied?.(limits, budgets);
  });
}
