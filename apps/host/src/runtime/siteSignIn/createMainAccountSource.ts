// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The main account a site's round runs for, as the window's own core reports it. The saved copy may show a session
// before any core reported one, and a local wallet's copy carries no key, so the source reads only the core's report.
// It holds a lease on that core, so the core stays up from the read to the round's signer calls.

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, listen, noop, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import type { CoreLease } from '../createPageCore.js';
import type { DotliAuthState } from '../session/types.js';
import { judgeReport, MainAccountError, type MainAccount, type ReportVerdict } from './mainAccount.js';

const report = createReporter({ flow: 'wallet' });
const mainAccountTransitionMetric = defineCount<'error'>('session_pages.main_account_transition');

/** The main account a site's round runs for, as the window's own core reports it. */
export type MainAccountSource = ReturnType<typeof createMainAccountSource>;

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

/**
 * `stale` is the report on show when the last held lease went down. A read skips it, since it is the dead core's and
 * not an answer of a core that is up. `shown` is the report heard last while holding. `stop` removes the held lease's
 * down listener and the report listener.
 */
type SourceState =
  | { kind: 'unleased'; stale: DotliAuthState | null }
  | { kind: 'leasing'; stale: DotliAuthState | null; reads: Reads }
  | {
      kind: 'holding';
      stale: DotliAuthState | null;
      shown: DotliAuthState | null;
      reads: Reads;
      lease: HeldLease;
      stop: () => void;
    }
  | { kind: 'disposing' }
  | { kind: 'disposed' };

type SourceEvent =
  | { kind: 'readAsked'; reply: Reply; signal: AbortSignal }
  | { kind: 'readAborted'; reply: Reply; reason: unknown }
  | { kind: 'leased'; lease: HeldLease }
  | { kind: 'leaseFailed'; error: unknown }
  | { kind: 'reported'; report: DotliAuthState | null }
  | { kind: 'down' }
  | { kind: 'disposed' };

/** `settled` stops the abort listener of each read, then answers it. */
type SourceEffect =
  | { kind: 'settled'; reads: Reads; outcome: Exclude<ReportVerdict, { kind: 'waiting' }> }
  | { kind: 'released'; lease: HeldLease };

type SourceMachine = MachineTypes<SourceState, SourceEvent, SourceEffect>;

/** Makes the source, which takes its lease on the first read. */
export function createMainAccountSource({ acquire, coreReport }: Params) {
  /** Fails a read whose signal aborted while it was open. */
  const abortRead: HandlerOf<SourceMachine, 'leasing' | 'holding', 'readAborted'> = (
    state,
    { reply, reason },
    { emitState, emitSideEffect },
  ) => {
    const stopAbort = state.reads.get(reply);
    // A read that settled in a transition queued before its abort has nothing left to fail.
    if (stopAbort === undefined) {
      return;
    }
    const reads = new Map(state.reads);
    reads.delete(reply);
    emitState({ ...state, reads });
    emitSideEffect({
      kind: 'settled',
      reads: new Map([[reply, stopAbort]]),
      outcome: { kind: 'failed', error: createReadError(reason) },
    });
  };
  /** Fails a read asked of a disposed source at once, since its reply must still settle. */
  const refuseRead: HandlerOf<SourceMachine, 'disposing' | 'disposed', 'readAsked'> = (
    _state,
    { reply },
    { emitSideEffect },
  ) => {
    // The read never listened for its abort, so it has no listener to stop.
    emitSideEffect({
      kind: 'settled',
      reads: new Map([[reply, noop]]),
      outcome: { kind: 'failed', error: createDisposedReadError() },
    });
  };
  const machine = createStateMachine<SourceMachine>({
    initial: { kind: 'unleased', stale: null },
    handlers: {
      unleased: {
        readAsked({ stale }, event, transition) {
          transition.emitState({ kind: 'leasing', stale, reads: addRead(new Map(), event, transition) });
          takeLease(transition);
        },
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      leasing: {
        readAsked(state, event, transition) {
          transition.emitState({ ...state, reads: addRead(state.reads, event, transition) });
        },
        readAborted: abortRead,
        leased({ stale, reads }, { lease }, { emitState, update }) {
          // A core already down calls its listener during the subscribe, so its `down` runs before the `reported` below.
          const stopDown = lease.subscribeDown(() => {
            update({ kind: 'down' });
          });
          const stopReport = coreReport.listen(report => {
            update({ kind: 'reported', report });
          });
          function stop(): void {
            stopDown();
            stopReport();
          }
          const shown = coreReport.get();
          emitState({ kind: 'holding', stale, shown, reads, lease, stop });
          update({ kind: 'reported', report: shown });
        },
        leaseFailed({ stale, reads }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'unleased', stale });
          emitSideEffect({ kind: 'settled', reads, outcome: { kind: 'failed', error: createReadError(error) } });
        },
        disposed({ reads }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'disposing' });
          emitSideEffect({ kind: 'settled', reads, outcome: { kind: 'failed', error: createDisposedReadError() } });
        },
      },
      holding: {
        readAsked(state, event, transition) {
          answerReads({ ...state, reads: addRead(state.reads, event, transition) }, transition);
        },
        readAborted: abortRead,
        reported(state, { report }, transition) {
          answerReads({ ...state, shown: report }, transition);
        },
        down({ shown: stale, reads, lease, stop }, _event, transition) {
          stop();
          // A replacement reports anew, so the reads still open wait for it on a new lease. The new lease is taken
          // before the old one goes, so the core is never left with no holder.
          if (reads.size > 0) {
            transition.emitState({ kind: 'leasing', stale, reads });
            takeLease(transition);
          } else {
            transition.emitState({ kind: 'unleased', stale });
          }
          transition.emitSideEffect({ kind: 'released', lease });
        },
        disposed({ reads, lease, stop }, _event, { emitState, emitSideEffect }) {
          stop();
          emitState({ kind: 'disposed' });
          // Every read settles before the release, so a release that throws leaves no read open.
          emitSideEffect({ kind: 'settled', reads, outcome: { kind: 'failed', error: createDisposedReadError() } });
          emitSideEffect({ kind: 'released', lease });
        },
      },
      disposing: {
        readAsked: refuseRead,
        leased(_state, { lease }, { emitState, emitSideEffect }) {
          emitState({ kind: 'disposed' });
          emitSideEffect({ kind: 'released', lease });
        },
        leaseFailed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      disposed: { readAsked: refuseRead },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'settled':
          for (const [reply, stopAbort] of effect.reads) {
            stopAbort();
            if (effect.outcome.kind === 'read') {
              reply.resolve(effect.outcome.account);
            } else {
              reply.reject(effect.outcome.error);
            }
          }
          return;
        case 'released':
          effect.lease.release();
          return;
      }
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
      if (signal.aborted) {
        return Promise.reject(createReadError(signal.reason));
      }
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
  function takeLease({ update }: Transition<SourceMachine>): void {
    update(
      acquire().then(
        (lease): SourceEvent => ({ kind: 'leased', lease }),
        (error: unknown): SourceEvent => ({ kind: 'leaseFailed', error }),
      ),
    );
  }

  /** Moves to `state`, settling its reads when its report answers them. */
  function answerReads(
    state: Extract<SourceState, { kind: 'holding' }>,
    { emitState, emitSideEffect }: Transition<SourceMachine>,
  ): void {
    const verdict = judgeReport(state.shown, state.stale);
    if (verdict.kind === 'waiting') {
      emitState(state);
      return;
    }
    emitState({ ...state, reads: new Map() });
    emitSideEffect({ kind: 'settled', reads: state.reads, outcome: verdict });
  }
}

/** `reads` with the read of `event` added, whose signal's abort comes back as an event. */
function addRead(
  reads: Reads,
  { reply, signal }: Extract<SourceEvent, { kind: 'readAsked' }>,
  { update }: Transition<SourceMachine>,
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

function createReadError(cause: unknown): MainAccountError {
  return new MainAccountError('unavailable', 'The main account could not be read', { cause });
}

function createDisposedReadError(): MainAccountError {
  return createReadError(new Error('The main account source was disposed'));
}
