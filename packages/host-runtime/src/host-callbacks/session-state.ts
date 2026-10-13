// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one writer of the auth store. Between the core's own reports the session is read from the saved copy at boot,
// shown `Unreachable` while the shared store is down, and read again once it is back.

import type { AuthState, SessionUiInfo } from '@parity/truapi-host';
import { m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, errorName, log } from '@dotli/shared';
import { getAuthState, setAuthState } from '../state/auth.js';
import { getWalletMode } from '../state/wallet-mode.js';
import { readWalletBoot, type LocalWalletBoot } from '../wallet-boot.js';
import type { DotliAuthState } from './AuthState.js';
import { coreStorage, type StoredSession } from './core-storage.js';

export interface TruapiSessionUiState {
  connected: boolean;
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
}

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

export interface SessionStateDeps {
  store: StoredSession;
  readWallet: () => Promise<LocalWalletBoot | null>;
  auth: AuthStateWriter;
  /** A local wallet's session lives in memory only, so it never touches the paired session's UI-state cache. */
  isLocalWallet: () => boolean;
}

/** How pairing presents itself in the modal. */
export interface PairingPresentation {
  label: string;
  dotSuffix?: boolean | undefined;
  hostGlobal?: boolean | undefined;
}

export interface SessionState {
  /** Reads the saved session now and follows the shared store's status. A second call returns the first one's stop. */
  start(): () => void;
  /**
   * Reads the saved session and ends `Restoring` or `Unreachable` with it. Calls queue behind the read in flight, and
   * each settles once its own read is applied.
   */
  refresh(): Promise<void>;
  /** A state the core reported, which also keeps the UI-state cache that boot rehydrates from. */
  reportCoreAuthState(state: AuthState, pairing: PairingPresentation): void;
  /** A login that failed before the core could report it. */
  reportLoginFailure(reason: string): void;
  /** A logout whose core never booted. The badge shows signed out although the saved session could not be cleared. */
  reportLogoutWithoutCore(): void;
}

export function createSessionState({ store, readWallet, auth, isLocalWallet }: SessionStateDeps): SessionState {
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

  /**
   * Ends `Restoring` or `Unreachable` with the local wallet when there is one, else with what was saved, and leaves
   * any other state alone, as the core has then said where the session stands.
   */
  const applySavedSession = async (): Promise<void> => {
    // Both go to the protocol frame, so the badge waits on whichever is slower, not on both in turn.
    const localWallet = readWallet();
    const raw = await store.readSession();
    const wallet = await localWallet;
    const session =
      wallet !== null
        ? localSessionUiState(wallet)
        : raw === null
          ? null
          : ((await readUiCache()) ?? { connected: true });
    if (!awaitsSavedSession()) {
      return;
    }
    if (session !== null) {
      auth.set({ tag: 'Connected', session });
    } else {
      auth.set({ tag: lastReadFailed ? 'Unreachable' : 'Disconnected' });
    }
  };

  const refresh = (): Promise<void> => savedSessionReads.call(applySavedSession);

  /** A store that is down cannot confirm a logout or a session, so a user who is not signed in waits on it. */
  const markUnreachable = (): void => {
    const tag = auth.get().tag;
    if (tag === 'Restoring' || tag === 'Disconnected') {
      auth.set({ tag: 'Unreachable' });
    }
  };

  let stop: (() => void) | null = null;

  return {
    start() {
      if (stop !== null) {
        return stop;
      }
      let lastStatus = store.getStatus();
      const unsubscribe = store.subscribeStatus(status => {
        const recovered = lastStatus === 'unavailable' && status === 'available';
        lastStatus = status;
        if (status === 'unavailable') {
          markUnreachable();
        } else if (recovered) {
          void refresh();
        }
      });
      void refresh();
      stop = () => {
        unsubscribe();
        stop = null;
      };
      return stop;
    },
    refresh,
    reportCoreAuthState(state, pairing) {
      switch (state.tag) {
        case 'Pairing': {
          auth.set({
            tag: 'Pairing',
            deeplink: state.value.deeplink,
            label: pairing.label,
            dotSuffix: pairing.dotSuffix,
            hostGlobal: pairing.hostGlobal,
          });
          break;
        }
        case 'Authenticating': {
          auth.set({ tag: 'Authenticating' });
          break;
        }
        case 'Connected': {
          const session = toSessionUiState(state.value);
          if (!isLocalWallet()) {
            void writeUiCache(session);
          }
          auth.set({ tag: 'Connected', session });
          break;
        }
        case 'Disconnected': {
          if (!isLocalWallet()) {
            // The core reads an unreadable store as no session, which is not a logout, so the cached account stays.
            if (lastReadFailed) {
              auth.set({ tag: 'Unreachable' });
              break;
            }
            void writeUiCache({ connected: false });
          }
          auth.set({ tag: 'Disconnected' });
          break;
        }
        case 'LoginFailed': {
          auth.set({ tag: 'LoginFailed', kind: state.value.kind, reason: state.value.reason });
          break;
        }
      }
    },
    reportLoginFailure(reason) {
      auth.set({ tag: 'LoginFailed', kind: 'Other', reason });
    },
    reportLogoutWithoutCore() {
      auth.set({ tag: 'Disconnected' });
    },
  };
}

/** The page's session state, the one writer of the auth store. */
export const sessionState: SessionState = createSessionState({
  store: coreStorage,
  readWallet: readWalletBoot,
  auth: { get: getAuthState, set: setAuthState },
  isLocalWallet: () => getWalletMode() === 'local',
});

/** At once at boot, as the auth button spins until the saved session is read. */
export function startSessionState(): () => void {
  return sessionState.start();
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** The cache can be stale from another code version or corrupt, so a malformed blob degrades to null. */
function parseUiStateCache(raw: string): TruapiSessionUiState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A stale cache, which the next session report rewrites, rather than a failure.
    log.event('Session UI cache unreadable', { flow: 'storage', error: errorName(err) ?? 'unknown' });
    m.count(S.SHARED_SESSION_UI_CACHE, { outcome: 'invalid', reason: 'json' });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const state = parsed as Record<string, unknown>;
  if (
    state['connected'] !== true ||
    !isOptionalString(state['publicKey']) ||
    !isOptionalString(state['identityAccountId']) ||
    !isOptionalString(state['liteUsername']) ||
    !isOptionalString(state['fullUsername']) ||
    !isOptionalString(state['primaryUsername'])
  ) {
    return null;
  }
  return {
    connected: true,
    ...(state['publicKey'] !== undefined ? { publicKey: state['publicKey'] } : {}),
    ...(state['identityAccountId'] !== undefined ? { identityAccountId: state['identityAccountId'] } : {}),
    ...(state['liteUsername'] !== undefined ? { liteUsername: state['liteUsername'] } : {}),
    ...(state['fullUsername'] !== undefined ? { fullUsername: state['fullUsername'] } : {}),
    ...(state['primaryUsername'] !== undefined ? { primaryUsername: state['primaryUsername'] } : {}),
  };
}

/** Before the first network read the record has no identity, so the badge shows signed in without a name. */
function localSessionUiState(wallet: LocalWalletBoot): TruapiSessionUiState {
  const identity = wallet.identity;
  if (identity === null) {
    return { connected: true };
  }
  return {
    connected: true,
    identityAccountId: identity.identityAccountId,
    ...(identity.liteUsername !== null
      ? { liteUsername: identity.liteUsername, primaryUsername: identity.liteUsername }
      : {}),
  };
}
