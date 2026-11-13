// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core's storage slots. The session blob and its UI-state cache live in the shared store, so every subdomain sees
// one session. Every other slot lives in this origin's localStorage, with secrets encrypted at rest.

import { SITE_ID } from '@dotli/config';
import type { CoreStorage } from '@parity/truapi-host';
import { SHARED_CORE_SESSION_KEY, getProtocolClient, type SharedStoreStatus } from '@dotli/protocol';
import { createReporter, defineCount } from '@dotli/metrics';
import { createListenerSet, toHex } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { pageRole } from '../pageRole.js';
import { createLocalCoreSlots, decodeStoredBytes } from './createLocalCoreSlots.js';
import { sessionPresence } from './createPagePresence.js';
import { createPageSignInFlag, type SignInFlag, type StoredSignIn } from './signInFlag.js';
import { recordPresenceWalletReadFailure, siteWallet } from './siteWallet.js';
import { sharedSessionUiCacheMetric } from './sharedSessionUiCacheMetric.js';

const storageReport = createReporter({ flow: 'storage' });

/**
 * One read of the login session shared across subdomains. Tagged `outcome` (hit, miss or error) and, on error,
 * `reason`, because a failed read shows the login screen exactly like a missing session.
 */
const sharedSessionReadMetric = defineCount<'error' | 'hit' | 'miss'>('shared_session.read');

/** This site's part of the shared auth store, which every subdomain reaches through the protocol frame. */
export type SharedSessionStore = {
  /** The value at `key`, or null for none. Rejects when the store cannot answer. */
  read(key: string): Promise<string | null>;
  /**
   * Resolves whether the value changed. An equal value is neither written nor told to other tabs. Rejects when the
   * store refuses it.
   */
  write(key: string, value: string): Promise<boolean>;
  /** Clears `key`. Rejects when the store refuses it. */
  clear(key: string): Promise<void>;
  /**
   * Clears `key` only while it still holds `expected`, in one step on the store. Resolves whether it did. Rejects when
   * the store refuses it.
   */
  clearIf(key: string, expected: string): Promise<boolean>;
  /** Hears the keys other tabs change. Returns the unsubscribe. */
  subscribe(listener: (key: string) => void): () => void;
  /** The store's status, reached when called, so building the store reaches no protocol client. Never throws. */
  getStatusStore: () => ReadableAtom<SharedStoreStatus>;
};

/** A read of the saved session, or why the store could not answer it. */
export type SessionRead = { status: 'ok'; blob: string | null } | { status: 'failed'; error: unknown };

type CreateAdaptersParams = {
  /**
   * The core keeps its session in memory, so its `AuthSession` slot is a no-op and nothing it does reaches the stored
   * session or the signed-in flag. For a core that must never write either.
   */
  sessionInMemory?: boolean | undefined;
};

/** The page's core storage, as its factory builds it. */
export type HostCoreStorage = ReturnType<typeof createCoreStorage>;

/** The saved session as session state reads it. */
export type StoredSession = Pick<
  HostCoreStorage,
  'readSession' | 'subscribeSessionReads' | 'readUiCache' | 'writeUiCache' | 'getStatusStore' | 'subscribeStoredSession'
>;

type Params = {
  /** This site's part of the shared auth store, where the session and its cached account live. */
  shared: SharedSessionStore;
  /** What every core's session write and clear go through, which moves the signed-in flag as the page's role says. */
  flag: SignInFlag;
};

// Beside the opaque session blob, so the account reads without decoding the blob.
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;

export function createCoreStorage({ shared, flag }: Params) {
  const slots = createLocalCoreSlots();
  // Writes in this tab, which the shared store's subscription does not report.
  const localChangeListeners = createListenerSet<undefined>({
    onListenerError: storageReport.listener('core_storage.local_change'),
  });
  const sessionReadListeners = createListenerSet<boolean>({
    onListenerError: storageReport.listener('core_storage.session_read'),
  });
  const sessionWriteFailures = createListenerSet<unknown>({
    onListenerError: storageReport.listener('core_storage.session_write'),
  });

  async function dropSessionIf(blob: string): Promise<boolean> {
    if (!(await shared.clearIf(SHARED_CORE_SESSION_KEY, blob))) {
      return false;
    }
    await writeUiCache(null);
    localChangeListeners.emit(undefined);
    return true;
  }

  async function installSession(blob: string, uiState: string | null): Promise<void> {
    // A copy that is the main store already holds the blob, yet may lack the account the window read, so a known
    // account is cached either way. An unknown one clears only the cache of a session this replaced.
    if ((await shared.write(SHARED_CORE_SESSION_KEY, blob)) || uiState !== null) {
      await writeUiCache(uiState);
    }
    localChangeListeners.emit(undefined);
  }

  // Hits and misses are counted too, so failures read as a rate. An unreachable shared store is the environment's
  // failure, so it is a breadcrumb rather than an issue.
  async function readSession(): Promise<SessionRead> {
    let raw: string | null;
    try {
      raw = await shared.read(SHARED_CORE_SESSION_KEY);
    } catch (error) {
      storageReport.expected(error, {
        step: 'session_read',
        metric: sharedSessionReadMetric,
        message: '[dot.li] shared auth session read failed:',
      });
      sessionReadListeners.emit(true);
      return { status: 'failed', error };
    }
    const blob = raw === '' ? null : raw;
    sharedSessionReadMetric.count({ outcome: blob === null ? 'miss' : 'hit' });
    sessionReadListeners.emit(false);
    return { status: 'ok', blob };
  }

  // An unreachable shared store is the environment's failure, so it is a breadcrumb rather than an issue.
  function reportUiCacheFailure(operation: 'read' | 'write' | 'clear', error: unknown): void {
    storageReport.expected(error, {
      step: 'ui_cache',
      metric: sharedSessionUiCacheMetric,
      reason: operation,
      message: `[dot.li] session UI cache ${operation} failed:`,
    });
  }

  async function readUiCache(): Promise<string | null> {
    try {
      return await shared.read(UI_STATE_CACHE_KEY);
    } catch (error) {
      reportUiCacheFailure('read', error);
      return null;
    }
  }

  async function writeUiCache(value: string | null): Promise<void> {
    try {
      if (value === null) {
        await shared.clear(UI_STATE_CACHE_KEY);
      } else {
        await shared.write(UI_STATE_CACHE_KEY, value);
      }
    } catch (error) {
      reportUiCacheFailure(value === null ? 'clear' : 'write', error);
    }
  }

  /** The `AuthSession` slot of one core, which drops only the session it last read or wrote. */
  function createSessionSlot() {
    let held: string | null = null;
    return {
      async read(): Promise<Uint8Array | undefined> {
        // Null for none and for a read that failed, never a throw, as a read error would make the core clear the
        // stored session, which would log every subdomain out.
        const read = await readSession();
        held = read.status === 'ok' ? read.blob : null;
        return held === null ? undefined : decodeStoredBytes(held, 'shared auth session');
      },
      async write(value: Uint8Array): Promise<void> {
        const blob = toHex(value);
        try {
          await flag.store(async () => {
            const changed = await shared.write(SHARED_CORE_SESSION_KEY, blob);
            held = blob;
            if (changed) {
              localChangeListeners.emit(undefined);
            }
          });
        } catch (error) {
          // The core hears it as its own write failing, and a login waiting for this session hears it here.
          sessionWriteFailures.emit(error);
          throw error;
        }
      },
      async clear(): Promise<void> {
        const blob = held;
        held = null;
        if (blob !== null) {
          await flag.clear({ drop: () => dropSessionIf(blob) });
        }
      },
    };
  }

  function subscribeStoredSession(listener: () => void): () => void {
    const unsubscribeLocal = localChangeListeners.subscribe(listener);
    const unsubscribeShared = shared.subscribe(key => {
      if (key === SHARED_CORE_SESSION_KEY) {
        listener();
      }
    });
    const sharedStatus = shared.getStatusStore();
    let lastStatus = sharedStatus.get();
    const unsubscribeStatus = sharedStatus.listen(status => {
      const recovered = lastStatus === 'unavailable' && status === 'available';
      lastStatus = status;
      // A core whose own read failed holds no session, so the store coming back is a change for it.
      if (recovered) {
        listener();
      }
    });

    function unsubscribe(): void {
      unsubscribeLocal();
      unsubscribeShared();
      unsubscribeStatus();
    }

    return unsubscribe;
  }

  return {
    /** Builds the slots one core reads and writes. Its clear drops only the session it last read or wrote. */
    createAdapters({ sessionInMemory = false }: CreateAdaptersParams = {}): CoreStorage {
      const session = sessionInMemory ? null : createSessionSlot();
      return {
        async readCoreStorage(key) {
          if (key.tag === 'AuthSession') {
            return session?.read();
          }
          return slots.read(key);
        },
        async writeCoreStorage(key, value) {
          if (key.tag === 'AuthSession') {
            await session?.write(value);
            return;
          }
          await slots.write(key, value);
        },
        async clearCoreStorage(key) {
          if (key.tag === 'AuthSession') {
            await session?.clear();
            return;
          }
          slots.clear(key);
        },
      };
    },
    /**
     * Clears the saved session and its cached account only while the session is still `blob`, so a sign-in stored
     * since stays. Resolves whether it did. Rejects when the store refuses it.
     */
    dropSessionIf,
    /**
     * Stores a session signed in elsewhere with its cached account, and tells this page's cores and session state, so
     * they pick it up without a reload. A blob equal to the stored one is left as it is, and they are still told, since
     * where the copy is the main store the window wrote it before any of them could follow. Rejects when the store
     * refuses the session.
     */
    installSession,
    /** The saved session, or why the store could not answer it. Never rejects, and reports a failed read itself. */
    readSession,
    /** Hears whether each session read failed, a core's or session state's own. Returns the unsubscribe. */
    subscribeSessionReads: sessionReadListeners.subscribe,
    /** Hears each core's write of its session that failed, with the failure. Returns the unsubscribe. */
    subscribeSessionWriteFailures: sessionWriteFailures.subscribe,
    /** The cached account, or null for none and for a read that failed. Never throws, and reports its own failure. */
    readUiCache,
    /** Null clears it. Never throws, and reports its own failure, as a stale cache only costs a stale name. */
    writeUiCache,
    /**
     * The shared store's status, reached when called, so building the storage reaches no protocol client. Never
     * throws.
     */
    getStatusStore: shared.getStatusStore,
    /**
     * Calls `listener` for a session written in this tab, changed by another tab, or readable again once the store is
     * back. Returns the unsubscribe.
     */
    subscribeStoredSession,
  };
}

/** The page's flag keeper, picked by the page's role on first use. */
export const signInFlag: SignInFlag = createPageSignInFlag({
  role: pageRole.get,
  presence: sessionPresence,
  readStoredSignIn,
});

/** The page's one core storage, so a write by one core reaches every other core's listener. */
export const coreStorage: HostCoreStorage = createCoreStorage({
  shared: createSiteSharedSessionStore(),
  flag: signInFlag,
});

/** The protocol frame's shared auth store, scoped to this site. */
function createSiteSharedSessionStore(): SharedSessionStore {
  return {
    read: key => getProtocolClient().sharedAuth.read(SITE_ID, key),
    write: (key, value) => getProtocolClient().sharedAuth.write({ siteId: SITE_ID, key, value }),
    clear: key => getProtocolClient().sharedAuth.clear(SITE_ID, key),
    clearIf: (key, expected) => getProtocolClient().sharedAuth.clearIf({ siteId: SITE_ID, key, expected }),
    subscribe: listener =>
      getProtocolClient().sharedAuth.subscribe(change => {
        if (change.tag === 'session' && change.value.siteId === SITE_ID) {
          listener(change.value.key);
        }
      }),
    getStatusStore: () => getProtocolClient().sharedStore.status,
  };
}

/** What the page's copy holds, as the page's flag keeper reads it after a write or a clear. Records a failed read. */
async function readStoredSignIn(): Promise<StoredSignIn> {
  const [session, wallet] = await Promise.all([
    coreStorage.readSession(),
    siteWallet.read().then(
      (read): StoredSignIn => (read.status === 'ok' ? 'held' : 'none'),
      (error: unknown): StoredSignIn => {
        recordPresenceWalletReadFailure(error);
        return 'unread';
      },
    ),
  ]);
  if ((session.status === 'ok' && session.blob !== null) || wallet === 'held') {
    return 'held';
  }
  return session.status === 'failed' || wallet === 'unread' ? 'unread' : 'none';
}
