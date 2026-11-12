// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the auth store. It shows the session of the saved copy or of the core that speaks for the page,
// and whether a sign-in made elsewhere waits for the page.

import type { SharedStoreStatus } from '@dotli/protocol';
import type { AuthState as CoreAuthState, SessionUiInfo } from '@parity/truapi-host';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, nest, noop, type MachineTypes, type Transition } from '@dotli/shared';
import { computed } from 'nanostores';
import { isResumeOffered, pageRole } from '../pageRole.js';
import { authState, type AuthState } from '../state/authState.js';
import { walletModeState } from '../state/walletModeState.js';
import { sessionElsewhereState } from '../state/sessionElsewhereState.js';
import { pageWalletBoot, type Restored } from '../createWalletBoot.js';
import { coreStorage, type SessionRead, type StoredSession } from './createCoreStorage.js';
import { getLocalSessionUiState } from './getLocalSessionUiState.js';
import { parseUiStateCache, type TruapiSessionUiState } from './parseUiStateCache.js';
import { authViews } from './authViews.js';
import type { DotliAuthState, Presence } from './types.js';

const report = createReporter({ flow: 'wallet' });
const sessionStateTransitionMetric = defineCount<'error'>('session.state_transition');
const savedSessionReadMetric = defineCount<'error'>('session.saved_session_read');

/** The auth store as its one writer sees it. */
export type AuthStateWriter = Pick<AuthState, 'store' | 'set'>;

/** What session state takes from the restore on load. */
type LoadRestore = Pick<Restored, 'local' | 'session' | 'wallet' | 'presence'>;

type Params = {
  /** The page's saved copy. */
  store: StoredSession;
  /**
   * What the restore rule left of the page's copy on load: the wallet the page boots on and the session. A session read
   * after it never finds a dead one. Never rejects, as a read the store could not answer is a failed read in the
   * result.
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

type GetSessionToShowParams = {
  local: LoadRestore['local'];
  raw: string | null;
  /** The raw cached account, read only for a session of the saved copy. */
  cached: string | null;
};

/** How pairing presents itself. */
export type PairingPresentation = {
  /** The name pairing presents. */
  label: string;
  /** Whether the label takes the active top-level domain. */
  dotSuffix?: boolean | undefined;
  /** Whether the pairing is for dotli itself rather than one product. */
  hostGlobal?: boolean | undefined;
};

/** Which read of the saved copy: the load's own, whose session the restore rule already read, or a read of the store. */
type Source = 'load' | 'store';

/** The read of the saved copy in flight, with the read asked meanwhile, which runs once it lands. */
type Read = { kind: 'none' } | { kind: 'reading'; rerun: Source | null };

/** One call of `start`, so a stop acts only on the follow that call began. */
type Run = object;

/** Following the shared store's status and the saved copy's changes, which only a started state does. */
type Follow = { kind: 'idle' } | { kind: 'following'; run: Run; stopListening: () => void };

/**
 * `shown` is the state the page shows. `coreReport` is the state the page's core reported last, and null while the
 * saved copy speaks for the page. `flag` is the flag as last read while the page held no sign-in. `storeReadFailed`
 * says whether the store's last session read failed, whichever reader made it. A disposed state keeps only the core's
 * last report.
 */
type State =
  | {
      kind: 'live';
      shown: DotliAuthState;
      coreReport: DotliAuthState | null;
      flag: Presence;
      storeReadFailed: boolean;
      follow: Follow;
      read: Read;
    }
  | { kind: 'disposed'; coreReport: DotliAuthState | null };

type Live = Extract<State, { kind: 'live' }>;

type Event =
  | { kind: 'started'; run: Run }
  | { kind: 'stopped'; run: Run }
  | { kind: 'followed' }
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
  | { kind: 'readAsked'; source: Source }
  // `flag` is the flag the load's restore read beside a copy that held nothing, and null for any other read.
  | { kind: 'readLanded'; session: TruapiSessionUiState | null; flag: Presence | null }
  | { kind: 'readRejected' };

type SessionMachine = MachineTypes<State, Event>;

/** The read nested in `live`. Its events are some of the machine's. */
type ReadMachine = MachineTypes<Read, Event>;

/** The follow nested in `live`. Its events are some of the machine's. */
type FollowMachine = MachineTypes<Follow, Event>;

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
        readRejected({ rerun }, _event, transition) {
          endRead(rerun, transition);
        },
      },
    },
  });
  const runFollow = nest<SessionMachine, 'live', FollowMachine, 'started' | 'stopped'>({
    find: state => state.follow,
    store: (state, _event, follow) => ({ ...state, follow }),
    handlers: {
      idle: {
        started(_follow, { run }, { emitState, update }) {
          // The listeners start before the state that holds their stop.
          const stopStatus = store.getStatusStore().listen(status => {
            update({ kind: 'storeStatus', status });
          });
          // A sign-in from the window, a change in another tab, and the store coming back after a read failed.
          const stopChanges = store.subscribeStoredSession(() => {
            update({ kind: 'storedSessionChanged' });
          });
          emitState({
            kind: 'following',
            run,
            stopListening: () => {
              stopStatus();
              stopChanges();
            },
          });
          update({ kind: 'followed' });
        },
      },
      following: {
        stopped(follow, { run }, { emitState }) {
          // The stop of a start that already ended ends nothing.
          if (run !== follow.run) {
            return;
          }
          emitState({ kind: 'idle' });
          follow.stopListening();
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
      follow: { kind: 'idle' },
      read: { kind: 'none' },
    },
    handlers: {
      live: {
        started: runFollow,
        stopped: runFollow,
        followed(state, _event, { update }) {
          // The load's own read, which the restore rule already made.
          if (isCopyAllowedToShow(state)) {
            update({ kind: 'readAsked', source: 'load' });
          }
        },
        storeStatus(state, { status }, transition) {
          // A store that is down cannot confirm a logout or a session, so a user who is not signed in waits on it.
          const { tag } = state.shown;
          if (status === 'unavailable' && (tag === 'Restoring' || tag === 'Disconnected')) {
            show(state, { shown: { tag: 'Unreachable' } }, transition);
          }
        },
        disposed(state, _event, { emitState }) {
          emitState({ kind: 'disposed', coreReport: state.coreReport });
          stopSessionReads();
          switch (state.follow.kind) {
            case 'following':
              state.follow.stopListening();
              return;
            case 'idle':
              return;
          }
        },
        sessionReadsHeard(state, { failed }, { emitState, update }) {
          emitState({ ...state, storeReadFailed: failed });
          if (!failed && state.shown.tag === 'Unreachable') {
            update({ kind: 'readAsked', source: 'store' });
          }
        },
        storedSessionChanged(state, _event, { update }) {
          if (isCopyAllowedToShow(state)) {
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
              writeUiCache(JSON.stringify(coreReport.session), transition);
              return;
            case 'Disconnected':
              writeUiCache(null, transition);
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
        flagRead(state, { presence }, { emitState }) {
          // A page that shows a sign-in ignores the flag.
          if (state.shown.tag === 'Connected') {
            return;
          }
          emitState({ ...state, flag: presence });
          setElsewhere(hasSignInElsewhere(presence, state.shown.tag));
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
          if (!isCopyAllowedToShow(state)) {
            return;
          }
          if (session !== null) {
            show(state, { shown: { tag: 'Connected', session } }, transition);
            return;
          }
          // A store that could not be read says nothing of a sign-out, so a sign-in on show stays.
          // A sign-in the core reported itself is its own report, so withdrawing to that report leaves it on show.
          if (state.coreReport !== null && !state.storeReadFailed && state.shown.tag === 'Connected') {
            show(state, { shown: getWithdrawnState(state.coreReport) }, transition);
            return;
          }
          if (authViews.isAwaitingSavedSession(state.shown)) {
            show(state, { shown: { tag: state.storeReadFailed ? 'Unreachable' : 'Disconnected' } }, transition);
          }
        },
        readAsked: runRead,
        readLanded: runRead,
        readRejected: runRead,
      },
      disposed: null,
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: sessionStateTransitionMetric,
        message: '[dot.li] A session state transition threw',
      });
    },
  });
  const stopSessionReads = store.subscribeSessionReads(failed => {
    machine.update({ kind: 'sessionReadsHeard', failed });
  });

  /**
   * Shows `changes.shown` with the facts that change beside it, and first says whether a sign-in made elsewhere waits,
   * so a listener of the auth state reads the answer that goes with it.
   */
  function show(
    state: Live,
    changes: Pick<Live, 'shown'> & Partial<Pick<Live, 'flag' | 'coreReport'>>,
    { emitState }: Transition<SessionMachine>,
  ): void {
    const next = { ...state, ...changes };
    // A read of the flag made before a sign-in says nothing of another sign-in once this one ends.
    const flag: Presence = next.shown.tag === 'Connected' ? 'unknown' : next.flag;
    emitState({ ...next, flag });
    setElsewhere(hasSignInElsewhere(flag, next.shown.tag));
    auth.set(next.shown);
  }

  function hasSignInElsewhere(flag: Presence, tag: DotliAuthState['tag']): boolean {
    return flag === 'present' && isShowingSignedOut(tag) && isResumeOffered();
  }

  function writeUiCache(value: string | null, { update }: Transition<SessionMachine>): void {
    // No state handles the event, which only lets `await()` cover the write.
    update(store.writeUiCache(value).then((): Event => ({ kind: 'uiCacheWritten' })));
  }

  function startRead(source: Source, { emitState, update }: Transition<ReadMachine>): void {
    emitState({ kind: 'reading', rerun: null });
    update(readSavedSession(source));
  }

  function endRead(rerun: Source | null, transition: Transition<ReadMachine>): void {
    if (rerun === null) {
      transition.emitState({ kind: 'none' });
      return;
    }
    startRead(rerun, transition);
  }

  /** Reads the saved session to show, in one step. A read that rejects is a defect, and ends as `readRejected`. */
  async function readSavedSession(source: Source): Promise<Event> {
    try {
      switch (source) {
        case 'load': {
          // The restore rule clears the cached account only with the session it drops, which makes the cache unused,
          // so the read starts beside the rule.
          const cachedAccount = store.readUiCache();
          const restored = await restore();
          const raw = getBlob(restored.session);
          return {
            kind: 'readLanded',
            session: getSessionToShow({ local: restored.local, raw, cached: await cachedAccount }),
            flag: hasHeldNothing(restored) ? restored.presence : null,
          };
        }
        case 'store': {
          // The restore first, since the session read must come after the rule.
          const { local } = await restore();
          const raw = getBlob(await store.readSession());
          // A sign-in elsewhere writes the cached account right after the session whose change started this read, so
          // the read waits for the session's.
          const cached = raw === null || local !== null ? null : await store.readUiCache();
          return { kind: 'readLanded', session: getSessionToShow({ local, raw, cached }), flag: null };
        }
      }
    } catch (error) {
      report.defect(error, {
        step: 'saved_session_read',
        metric: savedSessionReadMetric,
        message: '[dot.li] A saved session read failed',
      });
      return { kind: 'readRejected' };
    }
  }

  function getFollowStop(follow: Follow): () => void {
    switch (follow.kind) {
      case 'following':
        return () => {
          machine.update({ kind: 'stopped', run: follow.run });
        };
      // A start whose follow threw follows nothing.
      case 'idle':
        return noop;
    }
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
      switch (state.kind) {
        case 'live':
          return getFollowStop(state.follow);
        case 'disposed':
          return noop;
      }
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

// A core takes seconds to connect with a session stored for it, so while the page shows it signed out the copy may
// show one at once. A store that comes back may end `Unreachable` with no news from the core, whose session read
// already ended. A pairing stays the core's, and the core's next report decides from there. While a core's own report
// is open to it, the copy may also replace a sign-in it showed itself.
function isCopyAllowedToShow({ coreReport, shown }: Pick<Live, 'coreReport' | 'shown'>): boolean {
  return coreReport === null || isOpenToCopy(shown.tag) || isOpenToCopy(coreReport.tag);
}

/** The states in which the page holds no sign-in of its own and its button offers one. */
function isShowingSignedOut(tag: DotliAuthState['tag']): boolean {
  switch (tag) {
    case 'Disconnected':
    case 'Pairing':
    case 'Authenticating':
    case 'LoginFailed':
      return true;
    case 'Restoring':
    case 'Unreachable':
    case 'Connected':
      return false;
  }
}

/** The states the saved copy may replace while a core speaks for the page: signed out, failed or unreachable. */
function isOpenToCopy(tag: DotliAuthState['tag']): boolean {
  switch (tag) {
    case 'Disconnected':
    case 'LoginFailed':
    case 'Unreachable':
      return true;
    case 'Restoring':
    case 'Pairing':
    case 'Authenticating':
    case 'Connected':
      return false;
  }
}

/** Whether the load's restore left the copy without a session or a wallet, as far as it could read. */
function hasHeldNothing({ session, wallet }: Pick<Restored, 'session' | 'wallet'>): boolean {
  return (
    session.status === 'ok' && session.blob === null && (wallet.status === 'none' || wallet.status === 'unreadable')
  );
}

function getBlob(read: SessionRead): string | null {
  return read.status === 'ok' ? read.blob : null;
}

/** The session to show: the local wallet's when there is one, else the saved one with its cached account. */
function getSessionToShow({ local, raw, cached }: GetSessionToShowParams): TruapiSessionUiState | null {
  if (local !== null) {
    return getLocalSessionUiState(local.identity);
  }
  if (raw === null) {
    return null;
  }
  return (cached === null ? null : parseUiStateCache(cached)) ?? { connected: true };
}

/** The state the page shows for what the core reported. */
function getCoreReport(core: CoreAuthState, pairing: PairingPresentation): DotliAuthState {
  switch (core.tag) {
    case 'Pairing':
      return {
        tag: 'Pairing',
        deeplink: core.value.deeplink,
        label: pairing.label,
        dotSuffix: pairing.dotSuffix,
        hostGlobal: pairing.hostGlobal,
      };
    case 'Authenticating':
      return { tag: 'Authenticating' };
    case 'Connected':
      return { tag: 'Connected', session: getSessionUiState(core.value) };
    case 'Disconnected':
      return { tag: 'Disconnected' };
    case 'LoginFailed':
      return { tag: 'LoginFailed', kind: core.value.kind, reason: core.value.reason };
  }
}

function getSessionUiState(info: SessionUiInfo): TruapiSessionUiState {
  const primaryUsername = info.fullUsername ?? info.liteUsername;
  return {
    connected: true,
    publicKey: info.publicKey,
    ...(info.identityAccountId !== undefined ? { identityAccountId: info.identityAccountId } : {}),
    ...(info.liteUsername !== undefined ? { liteUsername: info.liteUsername } : {}),
    ...(info.fullUsername !== undefined ? { fullUsername: info.fullUsername } : {}),
    ...(primaryUsername !== undefined ? { primaryUsername } : {}),
  };
}

/**
 * The state a page shows once the copy withdraws its sign-in, the core's own report, with `Unreachable` shown as
 * `Disconnected` since the read that withdrew the sign-in has just answered.
 */
function getWithdrawnState(coreReport: DotliAuthState): DotliAuthState {
  if (coreReport.tag === 'Unreachable') {
    return { tag: 'Disconnected' };
  }
  return coreReport;
}
