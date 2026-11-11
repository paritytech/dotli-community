// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the auth store. It shows the session of the saved copy or of the core that speaks for the page,
// and whether a sign-in made elsewhere waits for the page.

import type { AuthState as CoreAuthState, SessionUiInfo } from '@parity/truapi-host';
import { createAsyncTaskPool, noop, registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';
import { isResumeOffered, pageRole } from '../pageRole.js';
import { authState, type AuthState } from '../state/authState.js';
import { walletModeState } from '../state/walletModeState.js';
import { sessionElsewhereState } from '../state/sessionElsewhereState.js';
import { pageWalletBoot, type Restored } from '../createWalletBoot.js';
import { coreStorage, type StoredSession } from './createCoreStorage.js';
import { getLocalSessionUiState } from './getLocalSessionUiState.js';
import { parseUiStateCache, type TruapiSessionUiState } from './parseUiStateCache.js';
import { authViews } from './authViews.js';
import type { DotliAuthState, Presence } from './types.js';

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
  /** The auth store this session state is the one writer of. */
  auth: AuthStateWriter;
  /** Where the page learns that it shows signed out while a sign-in exists elsewhere on the site. */
  setElsewhere: (next: boolean) => void;
  /** A local wallet's session lives in memory only, so it never touches the paired session's UI-state cache. */
  isLocalWallet: () => boolean;
  /** Whether the page offers to continue a sign-in made elsewhere, which its role decides. */
  isResumeOffered: () => boolean;
};

type ReadSessionToShowParams = {
  local: LoadRestore['local'];
  raw: string | null;
  readCachedAccount: () => Promise<string | null>;
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

/** Where session state is in its life. Only a started state follows the copy, and a disposed one never starts again. */
type Lifecycle = { kind: 'idle' } | { kind: 'started'; stop: () => void } | { kind: 'disposed' };

/** The page's session state, as its factory builds it. */
export type SessionState = ReturnType<typeof createSessionState>;

export function createSessionState({
  store,
  restore,
  auth: authStore,
  setElsewhere,
  isLocalWallet,
  isResumeOffered,
}: Params) {
  // The flag as last read while the page held no sign-in. A sign-in the page shows makes it unknown, since a read made
  // before it says nothing of another sign-in once this one ends.
  let flag: Presence = 'unknown';
  const auth: AuthStateWriter = {
    store: authStore.store,
    set(next) {
      if (next.tag === 'Connected') {
        flag = 'unknown';
      }
      // First, so a listener of the auth state reads the answer that goes with it.
      setElsewhere(hasSignInElsewhere(next.tag));
      authStore.set(next);
    },
  };
  // One read at a time, so a read that started before the store changed is never the last word.
  const savedSessionReads = createAsyncTaskPool({ poolSize: 1 });

  let lastReadFailed = false;
  const stopSessionReads = store.subscribeSessionReads(failed => {
    lastReadFailed = failed;
    if (!failed && auth.store.get().tag === 'Unreachable') {
      void retryRead();
    }
  });

  // Who speaks for the page's session: the saved copy, read here, or a core that reported, which follows the copy
  // itself. The page core says when its last core went.
  let speaker: 'copy' | 'core' = 'copy';

  const coreReportStore = atom<DotliAuthState | null>(null);
  registerAtomReset(coreReportStore);
  const coreReport: ReadableAtom<DotliAuthState | null> = coreReportStore;

  let lifecycle: Lifecycle = { kind: 'idle' };

  function hasSignInElsewhere(tag: DotliAuthState['tag']): boolean {
    return flag === 'present' && isShowingSignedOut(tag) && isResumeOffered();
  }

  function reportFlag(presence: Presence): void {
    const { tag } = auth.store.get();
    if (tag === 'Connected') {
      return;
    }
    flag = presence;
    setElsewhere(hasSignInElsewhere(tag));
  }

  function writeUiCache(state: TruapiSessionUiState): Promise<void> {
    return store.writeUiCache(state.connected ? JSON.stringify(state) : null);
  }

  function parseCachedAccount(raw: string | null): TruapiSessionUiState | null {
    return raw === null ? null : parseUiStateCache(raw);
  }

  // A core takes seconds to connect with a session stored for it, so while the page shows it signed out the copy may
  // show one at once. A store that comes back may end `Unreachable` with no news from the core, whose session read
  // already ended. A pairing stays the core's, and the core's next report decides from there. While a core's own report
  // is open to it, the copy may also replace a sign-in it showed itself.
  function isCopyAllowedToShow(): boolean {
    const report = coreReport.get();
    return speaker === 'copy' || isOpenToCopy(auth.store.get().tag) || (report !== null && isOpenToCopy(report.tag));
  }

  /** The session to show: the local wallet's when there is one, else the saved one with its cached account. */
  async function readSessionToShow({
    local,
    raw,
    readCachedAccount,
  }: ReadSessionToShowParams): Promise<TruapiSessionUiState | null> {
    if (local !== null) {
      return getLocalSessionUiState(local.identity);
    }
    if (raw === null) {
      return null;
    }
    return parseCachedAccount(await readCachedAccount()) ?? { connected: true };
  }

  /**
   * Shows the local wallet when there is one, else what was saved, while the copy may show it. A read that finds
   * nothing ends only `Restoring` or `Unreachable`, and, while a core speaks, withdraws a sign-in the copy showed
   * to the core's own report. It leaves a sign-out or a failure on show alone. `readCachedAccount` is the raw read of
   * the cached account, called only when a session of the saved copy is to be shown and never rejecting.
   */
  async function applySavedSession(
    readSession: (restored: LoadRestore) => Promise<string | null>,
    readCachedAccount: () => Promise<string | null>,
  ): Promise<void> {
    if (!isCopyAllowedToShow()) {
      return;
    }
    // The restore first, since the session read must come after the rule.
    const restored = await restore();
    const raw = await readSession(restored);
    const session = await readSessionToShow({ local: restored.local, raw, readCachedAccount });
    if (!isCopyAllowedToShow()) {
      return;
    }
    if (session !== null) {
      auth.set({ tag: 'Connected', session });
      return;
    }
    const shown = auth.store.get();
    // A store that could not be read says nothing of a sign-out, so a sign-in on show stays.
    // A sign-in the core reported itself is its own report, so withdrawing to that report leaves it on show.
    if (speaker === 'core' && !lastReadFailed && shown.tag === 'Connected') {
      auth.set(getWithdrawnState(coreReport.get()));
      return;
    }
    if (authViews.isAwaitingSavedSession(shown)) {
      auth.set({ tag: lastReadFailed ? 'Unreachable' : 'Disconnected' });
    }
  }

  /** Reads the saved session and shows it. Never rejects. */
  function readAndApply(): Promise<void> {
    return applySavedSession(
      async () => {
        const read = await store.readSession();
        return read.status === 'ok' ? read.blob : null;
      },
      // A sign-in elsewhere writes the cached account right after the session whose change started this read, so
      // the read waits for the session's.
      () => store.readUiCache(),
    );
  }

  /** Reads the saved session again and shows it, queued behind the read in flight, so the later read decides. */
  function refresh(): Promise<void> {
    return savedSessionReads.call(readAndApply);
  }

  function retryRead(): Promise<void> {
    return savedSessionReads.call(async () => {
      if (auth.store.get().tag !== 'Unreachable') {
        return;
      }
      await readAndApply();
    });
  }

  /** A store that is down cannot confirm a logout or a session, so a user who is not signed in waits on it. */
  function markUnreachable(): void {
    const tag = auth.store.get().tag;
    if (tag === 'Restoring' || tag === 'Disconnected') {
      auth.set({ tag: 'Unreachable' });
    }
  }

  /** Shows what the core reported, and keeps it as the core's own report. */
  function reportCore(next: DotliAuthState): void {
    coreReportStore.set(next);
    auth.set(next);
  }

  /** Follows the shared store and the saved copy, and returns the stop that ends it. */
  function follow(): () => void {
    const stops: (() => void)[] = [];
    const started: Lifecycle = { kind: 'started', stop: stopState };

    function stopState(): void {
      for (const stop of stops.splice(0)) {
        stop();
      }
      // A stop that runs after dispose leaves the state disposed.
      if (lifecycle === started) {
        lifecycle = { kind: 'idle' };
      }
    }

    // A stop or dispose that re-enters from a call below has already run, so what it missed ends at once.
    function keep(stop: () => void): void {
      if (lifecycle !== started) {
        stop();
        return;
      }
      stops.push(stop);
    }

    // Written before any call out, so a call that re-enters finds the state started.
    lifecycle = started;
    keep(
      store.getStatusStore().listen(status => {
        if (status === 'unavailable') {
          markUnreachable();
        }
      }),
    );
    // The load's own read, which the restore rule already made, with the flag it read beside a copy that held
    // nothing.
    void savedSessionReads.call(() => {
      // The restore rule clears the cached account only with the session it drops, which makes the cache unused, so
      // the read starts beside the rule. It never rejects.
      const cachedAccount = store.readUiCache();
      return applySavedSession(
        restored => {
          if (hasHeldNothing(restored)) {
            reportFlag(restored.presence);
          }
          const { session } = restored;
          return Promise.resolve(session.status === 'ok' ? session.blob : null);
        },
        () => cachedAccount,
      );
    });
    // A sign-in from the window, a change in another tab, and the store coming back after a read failed.
    keep(
      store.subscribeStoredSession(() => {
        if (isCopyAllowedToShow()) {
          void refresh();
        }
      }),
    );
    return stopState;
  }

  function dispose(): void {
    const ended = lifecycle;
    lifecycle = { kind: 'disposed' };
    stopSessionReads();
    if (ended.kind === 'started') {
      ended.stop();
    }
  }

  return {
    /**
     * The state the page's core itself reported last, as the page shows it. Null before any core reported and again
     * once the page's last core went. The saved copy never writes it, so it holds only a core's own report.
     */
    coreReport,
    /**
     * Shows the session the load's restore left, reads the saved copy again whenever it changes, such as by a sign-in
     * from the window or the shared store coming back, and shows `Unreachable` while the shared store is down. The copy
     * speaks for the page only while no core does. A second call returns the first one's stop. A disposed state
     * follows nothing and returns a stop that does nothing.
     */
    start(): () => void {
      switch (lifecycle.kind) {
        case 'idle':
          return follow();
        case 'started':
          return lifecycle.stop;
        case 'disposed':
          return noop;
      }
    },
    /** The page's last core went, so the saved copy speaks for the page again, read at once and on each change. */
    reportCoresGone(): void {
      speaker = 'copy';
      coreReportStore.set(null);
      void refresh();
    },
    /**
     * A state the core reported, which also keeps the UI-state cache. From then the page is
     * that core's, which follows the copy itself, until the page's last core went.
     */
    reportCoreAuthState(state: CoreAuthState, pairing: PairingPresentation): void {
      speaker = 'core';
      switch (state.tag) {
        case 'Pairing': {
          reportCore({
            tag: 'Pairing',
            deeplink: state.value.deeplink,
            label: pairing.label,
            dotSuffix: pairing.dotSuffix,
            hostGlobal: pairing.hostGlobal,
          });
          break;
        }
        case 'Authenticating': {
          reportCore({ tag: 'Authenticating' });
          break;
        }
        case 'Connected': {
          const session = getSessionUiState(state.value);
          if (!isLocalWallet()) {
            void writeUiCache(session);
          }
          reportCore({ tag: 'Connected', session });
          break;
        }
        case 'Disconnected': {
          if (!isLocalWallet()) {
            // The core reads an unreadable store as no session, which is not a logout, so the cached account stays.
            if (lastReadFailed) {
              reportCore({ tag: 'Unreachable' });
              break;
            }
            void writeUiCache({ connected: false });
          }
          reportCore({ tag: 'Disconnected' });
          break;
        }
        case 'LoginFailed': {
          reportCore({ tag: 'LoginFailed', kind: state.value.kind, reason: state.value.reason });
          break;
        }
      }
    },
    /** A login that failed before the core could report it. */
    reportLoginFailure(reason: string): void {
      auth.set({ tag: 'LoginFailed', kind: 'Other', reason });
    },
    /**
     * The page is signed out with no core to report it: a logout whose core never booted, shown signed out although
     * the saved session could not be cleared, or a sign-in ended on another page, whose saved copy this
     * page already dropped.
     */
    reportSignedOut(): void {
      // Every such sign-out deleted the flag, here or on the page that signed out.
      flag = 'absent';
      auth.set({ tag: 'Disconnected' });
    },
    /**
     * The signed-in flag as a recheck read it while the page held no sign-in, so the page says whether a sign-in made
     * elsewhere waits for it: the flag is set while the page holds none, as in Safari, where each product keeps its own
     * copy. A page that shows a sign-in ignores it. A page that pairs in place offers none, as only the window resumes
     * one.
     */
    reportFlag,
    /**
     * Reads the saved session again while the page shows `Unreachable`, queued behind the read in flight, and settles
     * once that read was applied. Settles without a read in any other state. Never rejects. `Unreachable` is left by a
     * read that answers, whichever reader made it, so a core's read that answers also starts one.
     */
    retryRead,
    /**
     * Stops hearing the store's session reads and ends the follow `start` began, is safe to call twice and never
     * throws, and leaves a state that is not started again, while a read already queued still settles and writes the
     * auth state once.
     */
    dispose,
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
function getWithdrawnState(report: DotliAuthState | null): DotliAuthState {
  if (report === null || report.tag === 'Unreachable') {
    return { tag: 'Disconnected' };
  }
  return report;
}
