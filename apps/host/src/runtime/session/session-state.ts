// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the auth store. It shows the session of the saved copy or of the core that speaks for the page,
// and whether a sign-in made elsewhere waits for the page.

import type { AuthState, SessionUiInfo } from '@parity/truapi-host';
import { createAsyncTaskPool, createSyncStore, type ReadableStore } from '@dotli/shared';
import { offersResume, pageRole } from '../page-role.js';
import { getAuthState, setAuthState } from '../state/auth.js';
import { getWalletMode } from '../state/wallet-mode.js';
import { setSessionElsewhere } from '../state/session-elsewhere.js';
import { restoreOnBoot, type Restored } from '../wallet-boot.js';
import type { DotliAuthState } from './auth-state.js';
import { coreStorage, type StoredSession } from './core-storage.js';
import type { Presence } from './presence.js';
import { localSessionUiState, parseUiStateCache, type TruapiSessionUiState } from './ui-state.js';

export type { TruapiSessionUiState } from './ui-state.js';

function toSessionUiState(info: SessionUiInfo): TruapiSessionUiState {
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

/** The auth store as its one writer sees it. */
export interface AuthStateWriter {
  get(): DotliAuthState;
  set(next: DotliAuthState): void;
}

/** What session state takes from the restore on load. */
type LoadRestore = Pick<Restored, 'local' | 'session' | 'wallet' | 'presence'>;

export interface SessionStateDeps {
  store: StoredSession;
  /**
   * What the restore rule left of the page's copy on load: the wallet the page boots on and the session. A session read
   * after it never finds a dead one.
   */
  restore: () => Promise<LoadRestore>;
  auth: AuthStateWriter;
  /** Where the page learns that it shows signed out while a sign-in exists elsewhere on the site. */
  elsewhere: (next: boolean) => void;
  /** A local wallet's session lives in memory only, so it never touches the paired session's UI-state cache. */
  isLocalWallet: () => boolean;
  /** Whether the page offers to continue a sign-in made elsewhere, which its role decides. */
  offersResume: () => boolean;
}

/** How pairing presents itself in the modal. */
export interface PairingPresentation {
  label: string;
  dotSuffix?: boolean | undefined;
  hostGlobal?: boolean | undefined;
}

export interface SessionState {
  /**
   * The state the page's core itself reported last, as the page shows it. Null before any core reported and again once
   * the page's last core went. The saved copy never writes it, so a reader of it never takes the copy for the core.
   */
  coreReport: ReadableStore<DotliAuthState | null>;
  /**
   * Shows the session the load's restore left, reads the saved copy again whenever it changes, such as by a sign-in
   * from the window or the shared store coming back, and shows `Unreachable` while the shared store is down. The copy
   * speaks for the page only while no core does. A second call returns the first one's stop.
   */
  start(): () => void;
  /** The page's last core went, so the saved copy speaks for the page again, read at once and on each change. */
  coresGone(): void;
  /**
   * A state the core reported, which also keeps the UI-state cache that boot rehydrates from. From then the page is
   * that core's, which follows the copy itself, until the page's last core went.
   */
  reportCoreAuthState(state: AuthState, pairing: PairingPresentation): void;
  /** A login that failed before the core could report it. */
  reportLoginFailure(reason: string): void;
  /**
   * The page is signed out with no core to report it: a logout whose core never booted, where the badge shows signed
   * out although the saved session could not be cleared, or a sign-in ended on another page, whose saved copy this page
   * already dropped.
   */
  reportSignedOut(): void;
  /**
   * The signed-in flag as a recheck read it while the page held no sign-in, so the page says whether a sign-in made
   * elsewhere waits for it: the flag is set while the page holds none, as in Safari, where each product keeps its own
   * copy. A page that shows a sign-in ignores it. A page that pairs in place offers none, as only the window resumes
   * one.
   */
  reportFlag(presence: Presence): void;
}

/** The states in which the page holds no sign-in of its own and its button offers one. */
function showsSignedOut(tag: DotliAuthState['tag']): boolean {
  return tag === 'Disconnected' || tag === 'Pairing' || tag === 'Authenticating' || tag === 'LoginFailed';
}

/** Whether the load's restore left the copy without a session or a wallet, as far as it could read. */
function heldNothing({ session, wallet }: Pick<Restored, 'session' | 'wallet'>): boolean {
  return (
    session.status === 'ok' && session.blob === null && (wallet.status === 'none' || wallet.status === 'unreadable')
  );
}

export function createSessionState(deps: SessionStateDeps): SessionState {
  const { store, restore, isLocalWallet } = deps;
  // The flag as last read while the page held no sign-in. A sign-in the page shows makes it unknown, since a read made
  // before it says nothing of another sign-in once this one ends.
  let flag: Presence = 'unknown';
  const elsewhereIn = (tag: DotliAuthState['tag']): boolean =>
    flag === 'present' && showsSignedOut(tag) && deps.offersResume();
  const auth: AuthStateWriter = {
    get: () => deps.auth.get(),
    set: next => {
      if (next.tag === 'Connected') {
        flag = 'unknown';
      }
      // First, so a listener of the auth state reads the answer that goes with it.
      deps.elsewhere(elsewhereIn(next.tag));
      deps.auth.set(next);
    },
  };
  const heardFlag = (presence: Presence): void => {
    const { tag } = auth.get();
    if (tag === 'Connected') {
      return;
    }
    flag = presence;
    deps.elsewhere(elsewhereIn(tag));
  };
  let lastReadFailed = false;
  store.subscribeSessionReads(failed => {
    lastReadFailed = failed;
  });

  // One read at a time, so a read that started before the store changed is never the last word.
  const savedSessionReads = createAsyncTaskPool({ poolSize: 1 });

  /** Not yet known or known to be unreadable, the only states a read of the saved session may end. */
  const awaitsSavedSession = (): boolean => {
    const tag = auth.get().tag;
    return tag === 'Restoring' || tag === 'Unreachable';
  };

  const writeUiCache = (state: TruapiSessionUiState): Promise<void> =>
    store.writeUiCache(state.connected ? JSON.stringify(state) : null);

  const readUiCache = async (): Promise<TruapiSessionUiState | null> => {
    const raw = await store.readUiCache();
    return raw === null ? null : parseUiStateCache(raw);
  };

  // Who speaks for the page's session: the saved copy, read here, or a core that reported, which follows the copy
  // itself. The page core says when its last core went.
  let speaker: 'copy' | 'core' = 'copy';
  const copySpeaks = (): boolean => speaker === 'copy';
  // A core takes seconds to connect with a session stored for it, so while the page shows it signed out the copy may
  // show one at once. A store that comes back may end `Unreachable` with no news from the core, whose session read
  // already ended. A pairing stays the core's, and the core's next report decides from there.
  const copyMayShow = (): boolean => {
    const { tag } = auth.get();
    return copySpeaks() || tag === 'Disconnected' || tag === 'LoginFailed' || tag === 'Unreachable';
  };

  /**
   * Shows the local wallet when there is one, else what was saved, while the copy may show it. A read
   * that finds nothing ends only `Restoring` or `Unreachable`, and leaves a sign-out or a failure on show alone.
   */
  const applySavedSession = async (readSession: (restored: LoadRestore) => Promise<string | null>): Promise<void> => {
    if (!copyMayShow()) {
      return;
    }
    // The restore first, since the session read must come after the rule.
    const restored = await restore();
    const wallet = restored.local;
    const raw = await readSession(restored);
    const session =
      wallet !== null
        ? localSessionUiState(wallet.identity)
        : raw === null
          ? null
          : ((await readUiCache()) ?? { connected: true });
    if (!copyMayShow()) {
      return;
    }
    if (session !== null) {
      auth.set({ tag: 'Connected', session });
    } else if (awaitsSavedSession()) {
      auth.set({ tag: lastReadFailed ? 'Unreachable' : 'Disconnected' });
    }
  };

  /** Reads the saved session again and shows it, queued behind the read in flight, so the later read decides. */
  const refresh = (): Promise<void> =>
    savedSessionReads.call(() =>
      applySavedSession(async () => {
        const read = await store.readSession();
        return read.status === 'ok' ? read.blob : null;
      }),
    );

  /** A store that is down cannot confirm a logout or a session, so a user who is not signed in waits on it. */
  const markUnreachable = (): void => {
    const tag = auth.get().tag;
    if (tag === 'Restoring' || tag === 'Disconnected') {
      auth.set({ tag: 'Unreachable' });
    }
  };

  const coreReport = createSyncStore<DotliAuthState | null>('sessionCoreReport', null);

  /** Shows what the core reported, and keeps it as the core's own report. */
  const reportCore = (next: DotliAuthState): void => {
    coreReport.set(next);
    auth.set(next);
  };

  let stop: (() => void) | null = null;

  return {
    coreReport,
    start() {
      if (stop !== null) {
        return stop;
      }
      const stopStatus = store.subscribeStatus(status => {
        if (status === 'unavailable') {
          markUnreachable();
        }
      });
      // The load's own read, which the restore rule already made, with the flag it read beside a copy that held
      // nothing.
      void savedSessionReads.call(() =>
        applySavedSession(restored => {
          if (heldNothing(restored)) {
            heardFlag(restored.presence);
          }
          const { session } = restored;
          return Promise.resolve(session.status === 'ok' ? session.blob : null);
        }),
      );
      // A sign-in from the window, a change in another tab, and the store coming back after a read failed.
      const stopChanges = store.onStoredSessionChanged(() => {
        if (copyMayShow()) {
          void refresh();
        }
      });
      stop = () => {
        stopStatus();
        stopChanges();
        stop = null;
      };
      return stop;
    },
    coresGone() {
      speaker = 'copy';
      coreReport.set(null);
      void refresh();
    },
    reportCoreAuthState(state, pairing) {
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
          const session = toSessionUiState(state.value);
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
    reportLoginFailure(reason) {
      auth.set({ tag: 'LoginFailed', kind: 'Other', reason });
    },
    reportSignedOut() {
      // Every such sign-out deleted the flag, here or on the page that signed out.
      flag = 'absent';
      auth.set({ tag: 'Disconnected' });
    },
    reportFlag: heardFlag,
  };
}

/** The page's session state, the one writer of the auth store. */
export const sessionState: SessionState = createSessionState({
  store: coreStorage,
  restore: restoreOnBoot,
  auth: { get: getAuthState, set: setAuthState },
  elsewhere: setSessionElsewhere,
  isLocalWallet: () => getWalletMode() === 'local',
  // Read when first needed, as the role is chosen after this module loads.
  offersResume: () => offersResume(pageRole()),
});
