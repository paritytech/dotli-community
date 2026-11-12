// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the auth store. It shows the session of the saved copy or of the core that speaks for the page,
// and whether a sign-in made elsewhere waits for the page.

import type { SharedStoreStatus } from '@dotli/protocol';
import type { AuthState as CoreAuthState } from '@parity/truapi-host';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, nest, noop, type MachineTypes, type Transition } from '@dotli/shared';
import { computed } from 'nanostores';
import { isResumeOffered, pageRole } from '../pageRole.js';
import { authState, type AuthState } from '../state/authState.js';
import { walletModeState } from '../state/walletModeState.js';
import { sessionElsewhereState } from '../state/sessionElsewhereState.js';
import { pageWalletBoot } from '../pageWalletBoot.js';
import { coreStorage, type StoredSession } from './createCoreStorage.js';
import { getCoreReport, type PairingPresentation } from './getCoreReport.js';
import { readSavedSession, type LoadRestore, type SavedSessionSource } from './readSavedSession.js';
import { sessionDisplay } from './sessionDisplay.js';
import type { TruapiSessionUiState } from './parseUiStateCache.js';
import { authViews } from './authViews.js';
import type { DotliAuthState, Presence } from './types.js';

const report = createReporter({ flow: 'wallet' });
const sessionStateTransitionMetric = defineCount<'error'>('session.state_transition');
const savedSessionReadMetric = defineCount<'error'>('session.saved_session_read');

/** The auth store as its one writer sees it. */
export type AuthStateWriter = Pick<AuthState, 'store' | 'set'>;

type Params = {
  /** The page's saved copy. */
  store: StoredSession;
  /**
   * What the restore rule left of the page's copy on load: the wallet the page boots on and the session. A session read
   * after it never finds a dead one. A read the store could not answer is a failed read in the result. Rejects only
   * when the restore rule breaks its contract.
   */
  restore: () => Promise<LoadRestore>;
  /** The auth store this session state is the one writer of. Read once, for the state the page shows at build. */
  auth: AuthStateWriter;
  /** Where the page learns that it shows signed out while a sign-in exists elsewhere on the site. */
  setElsewhere: (next: boolean) => void;
  /** A local wallet's session lives in memory only, so it never touches the paired session's UI-state cache. */
  isLocalWallet: () => boolean;
  /** Whether the page offers to continue a sign-in made elsewhere, which its role decides. */
  isResumeOffered: () => boolean;
};

/** The read of the saved copy in flight, with the read asked meanwhile, which runs once it lands. */
type Read = { kind: 'none' } | { kind: 'reading'; rerun: SavedSessionSource | null };

/** One call of `start`, so a stop acts only on the follow that call began. */
type Run = object;

/** Following the shared store's status and the saved copy's changes, which only a started state does. */
type Follow = { kind: 'idle' } | { kind: 'following'; run: Run; stopListening: () => void };

/**
 * `shown` is the state the page shows. `coreReport` is the state the page's core reported last, and null while the
 * saved copy speaks for the page. `flag` is the flag as last read while the page held no sign-in. `storeReadFailed`
 * says whether the store's last session read failed, whichever reader made it, and `stopReads` stops hearing those
 * reads. A disposed state keeps only the core's last report.
 */
type State =
  | {
      kind: 'live';
      shown: DotliAuthState;
      coreReport: DotliAuthState | null;
      flag: Presence;
      storeReadFailed: boolean;
      stopReads: () => void;
      follow: Follow;
      read: Read;
    }
  | { kind: 'disposed'; coreReport: DotliAuthState | null };

type Live = Extract<State, { kind: 'live' }>;

type Event =
  | { kind: 'started'; run: Run }
  | { kind: 'stopped'; run: Run }
  | { kind: 'disposed' }
  | { kind: 'sessionReadsHeard'; failed: boolean }
  | { kind: 'storeStatus'; status: SharedStoreStatus }
  | { kind: 'storedSessionChanged' }
  | { kind: 'coresGone' }
  | { kind: 'coreReported'; state: CoreAuthState; pairing: PairingPresentation }
  | { kind: 'loginFailed'; reason: string }
  | { kind: 'signedOut' }
  | { kind: 'flagRead'; presence: Presence }
  | { kind: 'retryAsked' }
  | { kind: 'uiCacheWritten' }
  | { kind: 'savedSessionRead'; session: TruapiSessionUiState | null }
  | { kind: 'savedSessionFailed' }
  | { kind: 'readAsked'; source: SavedSessionSource }
  | { kind: 'readLanded'; session: TruapiSessionUiState | null; flag: Presence | null }
  | { kind: 'readRejected'; error: unknown };

/** `shown` goes out with whether a sign-in made elsewhere waits, which is told first. */
type Effect =
  | { kind: 'shown'; shown: DotliAuthState; elsewhere: boolean }
  | { kind: 'elsewhereTold'; elsewhere: boolean }
  | { kind: 'readSession'; source: SavedSessionSource }
  | { kind: 'readFailed'; error: unknown }
  | { kind: 'writeUiCache'; value: string | null }
  | { kind: 'stopped'; stops: readonly (() => void)[] };

type SessionMachine = MachineTypes<State, Event, Effect>;

/** The read nested in `live`. Its events and effects are some of the machine's. */
type ReadMachine = MachineTypes<Read, Event, Effect>;

/** The page's session state, as its factory builds it. */
export type SessionState = ReturnType<typeof createSessionState>;

export function createSessionState({ store, restore, auth, setElsewhere, isLocalWallet, isResumeOffered }: Params) {
  const runRead = nest<SessionMachine, 'live', ReadMachine, 'readAsked' | 'readLanded' | 'readRejected'>({
    find: state => state.read,
    store: (state, _event, read) => ({ ...state, read }),
    handlers: {
      none: {
        readAsked(_read, { source }, transition) {
          startRead(source, transition);
        },
      },
      reading: {
        // One read at a time, so a read that started before the copy changed is never the last word.
        readAsked({ rerun }, { source }, { emitState }) {
          emitState({ kind: 'reading', rerun: source === 'load' || rerun === 'load' ? 'load' : 'store' });
        },
        readLanded({ rerun }, { session, flag }, transition) {
          endRead(rerun, transition);
          if (flag !== null) {
            transition.update({ kind: 'flagRead', presence: flag });
          }
          transition.update({ kind: 'savedSessionRead', session });
        },
        readRejected({ rerun }, { error }, transition) {
          transition.emitSideEffect({ kind: 'readFailed', error });
          endRead(rerun, transition);
          transition.update({ kind: 'savedSessionFailed' });
        },
      },
    },
  });
  const machine = createStateMachine<SessionMachine>({
    initial: {
      kind: 'live',
      shown: auth.store.get(),
      coreReport: null,
      flag: 'unknown',
      storeReadFailed: false,
      stopReads: store.subscribeSessionReads(failed => {
        machine.update({ kind: 'sessionReadsHeard', failed });
      }),
      follow: { kind: 'idle' },
      read: { kind: 'none' },
    },
    handlers: {
      live: {
        started(state, { run }, { emitState, update }) {
          // A second start joins the follow the first one began.
          if (state.follow.kind === 'following') {
            return;
          }
          // The listeners start before the state that holds their stop.
          const stopStatus = store.getStatusStore().listen(status => {
            update({ kind: 'storeStatus', status });
          });
          // A sign-in from the window, a change in another tab, and the store coming back after a read failed.
          const stopChanges = store.subscribeStoredSession(() => {
            update({ kind: 'storedSessionChanged' });
          });
          const stopListening = (): void => {
            stopStatus();
            stopChanges();
          };
          emitState({ ...state, follow: { kind: 'following', run, stopListening } });
          // The load's own read, which the restore rule already made.
          if (sessionDisplay.isCopyAllowedToShow(state.coreReport, state.shown)) {
            update({ kind: 'readAsked', source: 'load' });
          }
        },
        stopped(state, { run }, { emitState, emitSideEffect }) {
          // The stop of a start that already ended ends nothing.
          if (state.follow.kind !== 'following' || run !== state.follow.run) {
            return;
          }
          emitState({ ...state, follow: { kind: 'idle' } });
          emitSideEffect({ kind: 'stopped', stops: [state.follow.stopListening] });
        },
        storeStatus(state, { status }, transition) {
          // A store that is down cannot confirm a logout or a session, so a user who is not signed in waits on it.
          const { tag } = state.shown;
          if (status === 'unavailable' && (tag === 'Restoring' || tag === 'Disconnected')) {
            show(state, { shown: { tag: 'Unreachable' } }, transition);
          }
        },
        disposed(state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'disposed', coreReport: state.coreReport });
          const { follow } = state;
          const stops = follow.kind === 'following' ? [state.stopReads, follow.stopListening] : [state.stopReads];
          emitSideEffect({ kind: 'stopped', stops });
        },
        sessionReadsHeard(state, { failed }, { emitState, update }) {
          emitState({ ...state, storeReadFailed: failed });
          if (!failed && state.shown.tag === 'Unreachable') {
            update({ kind: 'readAsked', source: 'store' });
          }
        },
        storedSessionChanged(state, _event, { update }) {
          if (sessionDisplay.isCopyAllowedToShow(state.coreReport, state.shown)) {
            update({ kind: 'readAsked', source: 'store' });
          }
        },
        coresGone(state, _event, { emitState, update }) {
          emitState({ ...state, coreReport: null });
          update({ kind: 'readAsked', source: 'store' });
        },
        coreReported(state, { state: core, pairing }, transition) {
          const local = isLocalWallet();
          const reported = getCoreReport(core, pairing);
          // The core reads an unreadable store as no session, which is not a logout, so the cached account stays.
          const coreReport: DotliAuthState =
            reported.tag === 'Disconnected' && !local && state.storeReadFailed ? { tag: 'Unreachable' } : reported;
          show(state, { shown: coreReport, coreReport }, transition);
          if (local) {
            return;
          }
          switch (coreReport.tag) {
            case 'Connected':
              transition.emitSideEffect({ kind: 'writeUiCache', value: JSON.stringify(coreReport.session) });
              return;
            case 'Disconnected':
              transition.emitSideEffect({ kind: 'writeUiCache', value: null });
              return;
            // Only a sign-in or a sign-out changes the cached account.
            case 'Restoring':
            case 'Unreachable':
            case 'Pairing':
            case 'Authenticating':
            case 'LoginFailed':
              return;
          }
        },
        loginFailed(state, { reason }, transition) {
          show(state, { shown: { tag: 'LoginFailed', kind: 'Other', reason } }, transition);
        },
        signedOut(state, _event, transition) {
          // Every such sign-out deleted the flag, here or on the page that signed out.
          show(state, { shown: { tag: 'Disconnected' }, flag: 'absent' }, transition);
        },
        flagRead(state, { presence }, { emitState, emitSideEffect }) {
          // A page that shows a sign-in ignores the flag.
          if (state.shown.tag === 'Connected') {
            return;
          }
          emitState({ ...state, flag: presence });
          emitSideEffect({ kind: 'elsewhereTold', elsewhere: isSignInElsewhere(presence, state.shown) });
        },
        retryAsked(state, _event, { update }) {
          if (state.shown.tag === 'Unreachable') {
            update({ kind: 'readAsked', source: 'store' });
          }
        },
        // Shows the local wallet when there is one, else what was saved, while the copy may show it. A read that finds
        // nothing ends only `Restoring` or `Unreachable`, and, while a core speaks, withdraws a sign-in the copy showed
        // to the core's own report. It leaves a sign-out or a failure on show alone.
        savedSessionRead(state, { session }, transition) {
          if (!sessionDisplay.isCopyAllowedToShow(state.coreReport, state.shown)) {
            return;
          }
          if (session !== null) {
            show(state, { shown: { tag: 'Connected', session } }, transition);
            return;
          }
          // A store that could not be read says nothing of a sign-out, so a sign-in on show stays.
          // A sign-in the core reported itself is its own report, so withdrawing to that report leaves it on show.
          if (state.coreReport !== null && !state.storeReadFailed && state.shown.tag === 'Connected') {
            show(state, { shown: sessionDisplay.getWithdrawnState(state.coreReport) }, transition);
            return;
          }
          if (authViews.isAwaitingSavedSession(state.shown)) {
            show(state, { shown: { tag: state.storeReadFailed ? 'Unreachable' : 'Disconnected' } }, transition);
          }
        },
        // A read that broke says nothing of the session, so a page still waiting for one shows it out of reach, which a
        // retry reads again.
        savedSessionFailed(state, _event, transition) {
          if (
            sessionDisplay.isCopyAllowedToShow(state.coreReport, state.shown) &&
            authViews.isAwaitingSavedSession(state.shown)
          ) {
            show(state, { shown: { tag: 'Unreachable' } }, transition);
          }
        },
        readAsked: runRead,
        readLanded: runRead,
        readRejected: runRead,
      },
      disposed: null,
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'shown':
          // Told first, so a listener of the auth state reads the answer that goes with it.
          setElsewhere(effect.elsewhere);
          auth.set(effect.shown);
          return;
        case 'elsewhereTold':
          setElsewhere(effect.elsewhere);
          return;
        case 'readSession':
          machine.update(
            readSavedSession({ source: effect.source, store, restore }).then(
              ({ session, flag }) => ({ kind: 'readLanded', session, flag }),
              (error: unknown) => ({ kind: 'readRejected', error }),
            ),
          );
          return;
        case 'readFailed':
          report.defect(effect.error, {
            step: 'saved_session_read',
            metric: savedSessionReadMetric,
            message: '[dot.li] A saved session read failed',
          });
          return;
        case 'writeUiCache':
          // No state handles the event, which only lets `await()` cover the write.
          machine.update(store.writeUiCache(effect.value).then((): Event => ({ kind: 'uiCacheWritten' })));
          return;
        case 'stopped':
          for (const stop of effect.stops) {
            stop();
          }
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: sessionStateTransitionMetric,
        message: '[dot.li] A session state transition threw',
      });
    },
  });

  /** Shows `changes.shown` with the facts that change beside it. */
  function show(
    state: Live,
    changes: Pick<Live, 'shown'> & Partial<Pick<Live, 'flag' | 'coreReport'>>,
    { emitState, emitSideEffect }: Transition<SessionMachine>,
  ): void {
    const next = { ...state, ...changes };
    // A read of the flag made before a sign-in says nothing of another sign-in once this one ends.
    const flag: Presence = next.shown.tag === 'Connected' ? 'unknown' : next.flag;
    emitState({ ...next, flag });
    emitSideEffect({ kind: 'shown', shown: next.shown, elsewhere: isSignInElsewhere(flag, next.shown) });
  }

  function isSignInElsewhere(flag: Presence, shown: DotliAuthState): boolean {
    return sessionDisplay.isSignInWaitingElsewhere(flag, shown.tag) && isResumeOffered();
  }

  function startRead(source: SavedSessionSource, { emitState, emitSideEffect }: Transition<ReadMachine>): void {
    emitState({ kind: 'reading', rerun: null });
    emitSideEffect({ kind: 'readSession', source });
  }

  function endRead(rerun: SavedSessionSource | null, transition: Transition<ReadMachine>): void {
    if (rerun === null) {
      transition.emitState({ kind: 'none' });
      return;
    }
    startRead(rerun, transition);
  }

  return {
    /**
     * The state the page's core itself reported last, as the page shows it. Null before any core reported and again
     * once the page's last core went. The saved copy never writes it, so it holds only a core's own report.
     */
    coreReport: computed(machine.state, state => state.coreReport),
    /**
     * Shows the session the load's restore left, reads the saved copy again whenever it changes, such as by a sign-in
     * from the window or the shared store coming back, and shows `Unreachable` while the shared store is down. The copy
     * speaks for the page only while no core does. A second call joins the follow the first one began, and a stop from
     * either call ends it. A stop called after its follow ended does nothing, and so does the stop a disposed state
     * returns.
     */
    start(): () => void {
      machine.update({ kind: 'started', run: {} });
      const state = machine.state.get();
      if (state.kind === 'disposed' || state.follow.kind === 'idle') {
        // A disposed state, or a start whose follow threw, follows nothing.
        return noop;
      }
      const { run } = state.follow;
      return () => {
        machine.update({ kind: 'stopped', run });
      };
    },
    /** The page's last core went, so the saved copy speaks for the page again, read at once and on each change. */
    reportCoresGone(): void {
      machine.update({ kind: 'coresGone' });
    },
    /**
     * A state the core reported, which also keeps the UI-state cache. From then the page is
     * that core's, which follows the copy itself, until the page's last core went.
     */
    reportCoreAuthState(state: CoreAuthState, pairing: PairingPresentation): void {
      machine.update({ kind: 'coreReported', state, pairing });
    },
    /** A login that failed before the core could report it. */
    reportLoginFailure(reason: string): void {
      machine.update({ kind: 'loginFailed', reason });
    },
    /**
     * The page is signed out with no core to report it: a logout whose core never booted, shown signed out although
     * the saved session could not be cleared, or a sign-in ended on another page, whose saved copy this
     * page already dropped.
     */
    reportSignedOut(): void {
      machine.update({ kind: 'signedOut' });
    },
    /**
     * The signed-in flag as a recheck read it while the page held no sign-in, so the page says whether a sign-in made
     * elsewhere waits for it: the flag is set while the page holds none, as in Safari, where each product keeps its own
     * copy. A page that shows a sign-in ignores it. A page that pairs in place offers none, as only the window resumes
     * one.
     */
    reportFlag(presence: Presence): void {
      machine.update({ kind: 'flagRead', presence });
    },
    /**
     * Asks a read of the saved session when the page shows `Unreachable` at the call, and settles once the session
     * state's work has settled, that read and any read it started included. Asks none in any other state. A read
     * that left `Unreachable` meanwhile only makes the asked read redundant. `Unreachable` is left by a read that
     * answers, whichever reader made it, so a core's read that answers also asks one.
     */
    retryRead(): Promise<void> {
      machine.update({ kind: 'retryAsked' });
      return machine.await();
    },
    /**
     * Stops hearing the store's session reads and ends the follow `start` began, and leaves a state that is not
     * started again. After it, a read in flight writes nothing, and every report and ask changes nothing. Safe to
     * call twice.
     */
    dispose(): void {
      machine.update({ kind: 'disposed' });
    },
  };
}

// The page's session state lives as long as the page, so nothing disposes it.
/** The page's session state, the one writer of the auth store. */
export const sessionState = createSessionState({
  store: coreStorage,
  restore: pageWalletBoot.restore,
  auth: authState,
  setElsewhere: sessionElsewhereState.set,
  isLocalWallet: walletModeState.isLocal,
  // Read when first needed, as the role is chosen after this module loads.
  isResumeOffered: () => isResumeOffered(pageRole.get()),
});
