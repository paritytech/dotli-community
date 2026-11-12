// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The main account a site's round runs for, as the window's own core reports it. The saved copy may show a session
// before any core reported one, and a local wallet's copy carries no key, so the source reads only the core's report.
// It holds a lease on that core, so the core stays up from the read to the round's signer calls.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  fromHex,
  hashBlake2b,
  listen,
  toHex,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import type { CoreLease } from '../createPageCore.js';
import { authViews } from '../session/authViews.js';
import type { DotliAuthState } from '../session/types.js';
import type { TruapiSessionUiState } from '../session/parseUiStateCache.js';

const report = createReporter({ flow: 'wallet' });
const mainAccountTransitionMetric = defineCount<'error'>('session_pages.main_account_transition');

/** The main account an action runs for. The round never sends any of it. */
export type MainAccount = {
  /** Hex of the hash of the main account's public key, whose grants these are. */
  owner: string;
  /** Null for an account with no username to show a site. */
  username: { name: string; kind: 'lite' | 'full' } | null;
};

/** The main account a site's round runs for, as the window's own core reports it. */
export type MainAccountSource = ReturnType<typeof createMainAccountSource>;

type MainAccountErrorKind = 'unavailable' | 'signed_out';

/** The two lease calls the source makes. */
type HeldLease = Pick<CoreLease, 'subscribeDown' | 'release'>;

type Params = {
  /** Takes a lease on the page's core, booting it when none runs. Rejects when the core cannot boot. */
  acquire: () => Promise<HeldLease>;
  /**
   * What the page's core itself reported last, null while no core reported. It keeps a core's last report after that
   * core went down, until another core reports or the page's last core goes. Every report is a new object, so a report
   * is never the same object as an earlier one.
   */
  coreReport: Pick<ReadableAtom<DotliAuthState | null>, 'get' | 'listen'>;
};

/** How one read settles. */
type Reply = { resolve: (account: MainAccount) => void; reject: (error: MainAccountError) => void };

/** The reads open, each with the stop of its abort listener. */
type Reads = ReadonlyMap<Reply, () => void>;

type Report = DotliAuthState | null;

/**
 * `stale` is the report on show when the last held lease went down. A read skips it, since it is the dead core's and
 * not an answer of a core that is up. `stop` removes the held lease's down listener and the report listener.
 */
type SourceState =
  | { kind: 'unleased'; stale: Report }
  | { kind: 'leasing'; stale: Report; reads: Reads }
  | { kind: 'holding'; stale: Report; reads: Reads; lease: HeldLease; stop: () => void }
  | { kind: 'disposing' }
  | { kind: 'disposed' };

type SourceEvent =
  | { kind: 'readAsked'; reply: Reply; signal: AbortSignal }
  | { kind: 'readAborted'; reply: Reply; reason: unknown }
  | { kind: 'leased'; lease: HeldLease }
  | { kind: 'leaseFailed'; error: unknown }
  | { kind: 'reported'; lease: HeldLease }
  | { kind: 'down'; lease: HeldLease }
  | { kind: 'disposed' };

type SourceMachine = MachineTypes<SourceState, SourceEvent>;

/** A key the core reports as `0x` hex of whole bytes. */
const HEX_KEY = /^0x(?:[0-9a-fA-F]{2})+$/;

/** Makes the source, which takes its lease on the first read. */
export function createMainAccountSource({ acquire, coreReport }: Params) {
  /** Fails a read whose signal aborted while it was open. */
  const abortRead: HandlerOf<SourceMachine, 'leasing' | 'holding', 'readAborted'> = (
    state,
    { reply, reason },
    { emitState },
  ) => {
    const stopAbort = state.reads.get(reply);
    // A read that settled in a transition queued before its abort has nothing left to fail.
    if (stopAbort === undefined) {
      return;
    }
    stopAbort();
    const reads = new Map(state.reads);
    reads.delete(reply);
    emitState({ ...state, reads });
    reply.reject(createReadError(reason));
  };
  /** Fails a read asked of a disposed source at once, since its reply must still settle. */
  const refuseRead: HandlerOf<SourceMachine, 'disposing' | 'disposed', 'readAsked'> = (_state, { reply }) => {
    reply.reject(createReadError(createDisposedError()));
  };
  /** Fails a read asked with an aborted signal at once, and tells whether it did. */
  function refuseAborted({ reply, signal }: Extract<SourceEvent, { kind: 'readAsked' }>): boolean {
    if (!signal.aborted) {
      return false;
    }
    reply.reject(createReadError(signal.reason));
    return true;
  }
  const machine = createStateMachine<SourceMachine>({
    initial: { kind: 'unleased', stale: null },
    handlers: {
      unleased: {
        readAsked({ stale }, event, { emitState, update }) {
          if (refuseAborted(event)) {
            return;
          }
          emitState({ kind: 'leasing', stale, reads: addRead(new Map(), event, update) });
          takeLease(update);
        },
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      leasing: {
        readAsked(state, event, { emitState, update }) {
          if (refuseAborted(event)) {
            return;
          }
          emitState({ ...state, reads: addRead(state.reads, event, update) });
        },
        readAborted: abortRead,
        leased({ stale, reads }, { lease }, { emitState, update }) {
          // A core already down calls its listener during the subscribe, so its `down` runs before the `reported` below.
          const stopDown = lease.subscribeDown(() => {
            update({ kind: 'down', lease });
          });
          const stopReport = coreReport.listen(() => {
            update({ kind: 'reported', lease });
          });
          function stop(): void {
            stopDown();
            stopReport();
          }
          emitState({ kind: 'holding', stale, reads, lease, stop });
          update({ kind: 'reported', lease });
        },
        leaseFailed({ stale, reads }, { error }, { emitState }) {
          stopAbortListeners(reads);
          emitState({ kind: 'unleased', stale });
          failReads(reads, error);
        },
        disposed({ reads }, _event, { emitState }) {
          stopAbortListeners(reads);
          emitState({ kind: 'disposing' });
          failReads(reads, createDisposedError());
        },
      },
      holding: {
        readAsked(state, event, transition) {
          if (refuseAborted(event)) {
            return;
          }
          answerReads({ ...state, reads: addRead(state.reads, event, transition.update) }, transition);
        },
        readAborted: abortRead,
        reported(state, { lease }, transition) {
          if (lease !== state.lease) {
            return;
          }
          answerReads(state, transition);
        },
        down({ reads, lease, stop }, event, { emitState, update }) {
          if (event.lease !== lease) {
            return;
          }
          stop();
          const stale = coreReport.get();
          // A replacement reports anew, so the reads still open wait for it on a new lease.
          if (reads.size > 0) {
            emitState({ kind: 'leasing', stale, reads });
            takeLease(update);
          } else {
            emitState({ kind: 'unleased', stale });
          }
          lease.release();
        },
        disposed({ reads, lease, stop }, _event, { emitState }) {
          stop();
          stopAbortListeners(reads);
          emitState({ kind: 'disposed' });
          // Every read settles before the release, so a release that throws leaves no read open.
          failReads(reads, createDisposedError());
          lease.release();
        },
      },
      disposing: {
        readAsked: refuseRead,
        leased(_state, { lease }, { emitState }) {
          emitState({ kind: 'disposed' });
          lease.release();
        },
        leaseFailed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      disposed: { readAsked: refuseRead },
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: mainAccountTransitionMetric,
        message: '[dot.li] A main account source transition threw',
      });
    },
  });

  return {
    /**
     * The main account once the core reports a session, on a core lease the source holds from the first read. Rejects
     * with a {@link MainAccountError}: `signed_out` once the core reports no session or a failed login, `unavailable`
     * for a core that cannot boot, a core that cannot read the main session, a session without a readable key,
     * `signal` aborting first, or the source disposed while the read is open or before it starts, which then takes no
     * new lease. A lease that cannot be taken fails every read waiting on it. After the leased core went down, the read
     * waits for its replacement's own report.
     */
    read(signal: AbortSignal): Promise<MainAccount> {
      return new Promise<MainAccount>((resolve, reject) => {
        machine.update({ kind: 'readAsked', reply: { resolve, reject }, signal });
      });
    },
    /**
     * Removes the down listener of the held lease and lets the lease go, lets go of a lease still being taken as soon
     * as it lands, fails every open read as `unavailable`, is safe to call twice and never throws.
     */
    dispose(): void {
      machine.update({ kind: 'disposed' });
    },
  };

  /** Takes a lease, whose landing or failure comes back as an event. */
  function takeLease(update: Transition<SourceMachine>['update']): void {
    update(
      acquire().then(
        (lease): SourceEvent => ({ kind: 'leased', lease }),
        (error: unknown): SourceEvent => ({ kind: 'leaseFailed', error }),
      ),
    );
  }

  /** Stops the abort listeners of the reads, empties them from the state and answers each reply. */
  function settleReads(
    state: Extract<SourceState, { kind: 'holding' }>,
    { emitState }: Transition<SourceMachine>,
    answer: (reply: Reply) => void,
  ): void {
    stopAbortListeners(state.reads);
    emitState({ ...state, reads: new Map() });
    for (const reply of state.reads.keys()) {
      answer(reply);
    }
  }

  /** Settles every read of `state` once the core's report answers them, and keeps them open otherwise. */
  function answerReads(state: Extract<SourceState, { kind: 'holding' }>, transition: Transition<SourceMachine>): void {
    const { emitState } = transition;
    const verdict = judgeReport(coreReport.get(), state.stale);
    switch (verdict.kind) {
      case 'waiting':
        emitState(state);
        return;
      case 'read':
        settleReads(state, transition, reply => {
          reply.resolve(verdict.account);
        });
        return;
      case 'failed':
        settleReads(state, transition, reply => {
          reply.reject(verdict.error);
        });
        return;
    }
  }
}

/** The main account of a session, or null for one without a readable public key. */
export function getMainAccount(session: TruapiSessionUiState): MainAccount | null {
  const { publicKey } = session;
  if (publicKey === undefined || !HEX_KEY.test(publicKey)) {
    return null;
  }
  const owner = toHex(hashBlake2b(fromHex(publicKey), 32));
  if (session.fullUsername !== undefined && session.fullUsername !== '') {
    return { owner, username: { name: session.fullUsername, kind: 'full' } };
  }
  if (session.liteUsername !== undefined && session.liteUsername !== '') {
    return { owner, username: { name: session.liteUsername, kind: 'lite' } };
  }
  return { owner, username: null };
}

/**
 * Why the main account could not be read. `signed_out` is a session the core reports gone, which only a new sign-in
 * brings back, and `unavailable` anything else, which a read may get past.
 */
export class MainAccountError extends Error {
  override name = 'MainAccountError';
  readonly kind: MainAccountErrorKind;

  constructor(kind: MainAccountErrorKind, message: string, { cause }: ErrorOptions = {}) {
    super(message, { cause });
    this.kind = kind;
  }
}

/** `reads` with the read of `event` added, whose signal's abort comes back as an event. */
function addRead(
  reads: Reads,
  { reply, signal }: Extract<SourceEvent, { kind: 'readAsked' }>,
  update: Transition<SourceMachine>['update'],
): Reads {
  const stopAbort = listen({
    target: signal,
    type: 'abort',
    handler: () => {
      update({ kind: 'readAborted', reply, reason: signal.reason });
    },
  });
  return new Map(reads).set(reply, stopAbort);
}

/** Stops the abort listeners of `reads`, which the state emitted next no longer holds. */
function stopAbortListeners(reads: Reads): void {
  for (const stopAbort of reads.values()) {
    stopAbort();
  }
}

/** Fails every read of `reads` as unavailable, each with `cause`. */
function failReads(reads: Reads, cause: unknown): void {
  for (const reply of reads.keys()) {
    reply.reject(createReadError(cause));
  }
}

function createReadError(cause: unknown): MainAccountError {
  return new MainAccountError('unavailable', 'The main account could not be read', { cause });
}

function createDisposedError(): Error {
  return new Error('The main account source was disposed');
}

/**
 * What the core's report `shown` answers a read. No report, the dead core's `stale` one and one on the way to a
 * session keep the read waiting.
 */
function judgeReport(
  shown: Report,
  stale: Report,
): { kind: 'waiting' } | { kind: 'read'; account: MainAccount } | { kind: 'failed'; error: MainAccountError } {
  if (shown === null || shown === stale) {
    return { kind: 'waiting' };
  }
  const session = authViews.getSignedInSession(shown);
  if (session !== null) {
    const account = getMainAccount(session);
    if (account === null) {
      return {
        kind: 'failed',
        error: new MainAccountError('unavailable', "The core's session has no readable public key"),
      };
    }
    return { kind: 'read', account };
  }
  if (authViews.isSignInIdle(shown)) {
    return {
      kind: 'failed',
      error: new MainAccountError('signed_out', `The window's core reports the main session ${shown.tag}`),
    };
  }
  if (authViews.isSessionUnreachable(shown)) {
    return {
      kind: 'failed',
      error: new MainAccountError('unavailable', "The window's core cannot read the main session"),
    };
  }
  return { kind: 'waiting' };
}
