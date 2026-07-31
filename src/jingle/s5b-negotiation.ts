import { HttpxError } from "../errors.js";
import {
  resolve as resolveOutcome,
  type S5bCandidate,
  type S5bOutcome,
  type S5bReport,
} from "../socks5/jingle-s5b.js";

/**
 * Per-session state for an XEP-0260 negotiation: what each side offered, what
 * each side reported, and the waiters the IQ handlers resolve.
 *
 * It exists because the negotiation is a conversation, not a call — the
 * responder's transfer cannot start until candidates arrive in a later
 * `transport-info`, and neither side can pick a winner until *both* reports are
 * in. Keeping that here (rather than inline in JingleManager) keeps the waiting
 * testable without any XMPP at all.
 *
 * Every waiter is bounded: a peer that goes quiet mid-negotiation must not park
 * a body stream forever.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const box: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => {
      if (box.settled) return;
      box.settled = true;
      resolve(value);
    },
    reject: (reason) => {
      if (box.settled) return;
      box.settled = true;
      reject(reason);
    },
  };
  // Nothing else may observe a rejection before the awaiting code does.
  promise.catch(() => {});
  return box;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HttpxError("timeout", message)), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class S5bNegotiation {
  /** Transport sid, shared by both sides and used as the SOCKS5 sid. */
  readonly sid: string;
  /** SHA-1(sid + initiator full JID + responder full JID); set once hashed. */
  dstaddr: string;
  readonly isInitiator: boolean;
  /** Full JIDs, in the roles the SOCKS5 hash and proxy activation need. */
  readonly initiatorJid: string;
  readonly responderJid: string;

  #localCandidates: S5bCandidate[] = [];
  #remoteCandidates: S5bCandidate[] = [];
  #remoteCandidatesReady = deferred<readonly S5bCandidate[]>();
  #localReport: S5bReport | undefined;
  #remoteReport: S5bReport | undefined;
  #outcome = deferred<S5bOutcome>();
  #activated = deferred<string>();
  #replaced = deferred<void>();

  constructor(init: {
    sid: string;
    dstaddr: string;
    isInitiator: boolean;
    initiatorJid: string;
    responderJid: string;
  }) {
    this.sid = init.sid;
    this.dstaddr = init.dstaddr;
    this.isInitiator = init.isInitiator;
    this.initiatorJid = init.initiatorJid;
    this.responderJid = init.responderJid;
  }

  get localCandidates(): readonly S5bCandidate[] {
    return this.#localCandidates;
  }

  get remoteCandidates(): readonly S5bCandidate[] {
    return this.#remoteCandidates;
  }

  /** Records what we offered; needed to check a peer's `candidate-used` cid. */
  offerLocal(candidates: readonly S5bCandidate[]): void {
    this.#localCandidates = [...candidates];
  }

  /**
   * Candidates from the peer. XEP-0260 allows more to arrive in later
   * transport-infos, so these accumulate; the waiter fires on the first batch,
   * which is the one the connect race uses.
   */
  receiveRemoteCandidates(candidates: readonly S5bCandidate[]): void {
    for (const candidate of candidates) {
      if (!this.#remoteCandidates.some((existing) => existing.cid === candidate.cid)) {
        this.#remoteCandidates.push(candidate);
      }
    }
    this.#remoteCandidatesReady.resolve(this.#remoteCandidates);
  }

  /** Resolves as soon as any candidates have arrived, or on an empty offer. */
  waitRemoteCandidates(timeoutMs: number): Promise<readonly S5bCandidate[]> {
    return withTimeout(
      this.#remoteCandidatesReady.promise,
      timeoutMs,
      "timed out waiting for s5b candidates",
    );
  }

  /** The peer offered nothing (an empty `<transport>` with no candidates). */
  noRemoteCandidates(): void {
    this.#remoteCandidatesReady.resolve(this.#remoteCandidates);
  }

  setLocalReport(report: S5bReport): void {
    this.#localReport ??= report;
    this.#settleIfReady();
  }

  /**
   * The peer's `<candidate-used/>`; the cid must name a candidate *we* offered.
   * A cid we never sent is a protocol error, not something to guess at.
   */
  setRemoteUsed(cid: string): void {
    const candidate = this.#localCandidates.find((entry) => entry.cid === cid);
    if (!candidate) {
      this.fail(
        new HttpxError(
          "protocol-error",
          `peer used candidate ${cid}, which we never offered`,
        ),
      );
      return;
    }
    this.#remoteReport ??= { kind: "used", candidate };
    this.#peerFinishedOffering();
    this.#settleIfReady();
  }

  setRemoteError(): void {
    this.#remoteReport ??= { kind: "error" };
    this.#peerFinishedOffering();
    this.#settleIfReady();
  }

  /**
   * A peer that has reported is done offering, so anyone waiting on candidates
   * should stop — otherwise a sender with nothing to offer parks the receiver
   * until its idle timeout instead of falling back promptly.
   */
  #peerFinishedOffering(): void {
    this.#remoteCandidatesReady.resolve(this.#remoteCandidates);
  }

  #settleIfReady(): void {
    if (!this.#localReport || !this.#remoteReport) return;
    this.#outcome.resolve(
      resolveOutcome({
        local: this.#localReport,
        remote: this.#remoteReport,
        isInitiator: this.isInitiator,
      }),
    );
  }

  /** The agreed candidate, or `fallback` when neither side could connect. */
  outcome(timeoutMs: number): Promise<S5bOutcome> {
    return withTimeout(
      this.#outcome.promise,
      timeoutMs,
      "timed out completing the s5b negotiation",
    );
  }

  markActivated(cid: string): void {
    this.#activated.resolve(cid);
  }

  /** Waits for `<activated/>` — only sent for a winning proxy candidate. */
  waitActivation(timeoutMs: number): Promise<string> {
    return withTimeout(
      this.#activated.promise,
      timeoutMs,
      "timed out waiting for the proxy to be activated",
    );
  }

  /**
   * Both sides agreed to switch transports. The trigger differs by role: the
   * responder marks it on receiving `transport-replace`, the initiator on the
   * peer's `transport-accept` — so neither starts moving bytes before the other
   * is listening.
   */
  markSwitch(): void {
    this.#replaced.resolve();
  }

  waitSwitch(timeoutMs: number): Promise<void> {
    return withTimeout(
      this.#replaced.promise,
      timeoutMs,
      "timed out switching to a replacement transport",
    );
  }

  /** Fails every waiter at once: a dead negotiation must not park a stream. */
  fail(error: unknown): void {
    this.#remoteCandidatesReady.reject(error);
    this.#outcome.reject(error);
    this.#activated.reject(error);
    this.#replaced.reject(error);
  }
}
