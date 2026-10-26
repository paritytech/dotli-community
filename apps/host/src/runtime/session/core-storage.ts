// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core's storage slots. The session blob and its UI-state cache live in the shared store, so every subdomain sees
// one session. Every other slot lives in this origin's localStorage, with secrets encrypted at rest.

import { SITE_ID } from '@dotli/config';
import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorage, CoreStorageKey } from '@parity/truapi-host';
import { SHARED_CORE_SESSION_KEY, protocolClient, type SharedStoreStatus } from '@dotli/protocol';
import { m, recordExpected, reportExpected, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  fromHex,
  idbRequest,
  idbTransaction,
  log,
  openIdb,
  toHex,
} from '@dotli/shared';
import { pageRole } from '../page-role.js';
import { sessionPresence } from './presence.js';
import { createPageSignInFlag, type SignInFlag, type StoredSignIn } from './sign-in-flag.js';
import { siteWallet } from './site-wallet.js';

const CORE_LOCAL_STORAGE_PREFIX = 'dotli:core:';

// Beside the opaque session blob, so boot rehydration never has to decode the blob.
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;

// Legacy plaintext slots are bare hex, so a decrypt failure never falls back to treating ciphertext as plaintext.
const ENCRYPTED_VALUE_PREFIX = 'enc1:';

// A fresh nonce per write, since GCM security collapses if a key and nonce pair is ever reused.
const CORE_SECRET_NONCE_LENGTH = 12;

const KEY_DB_NAME = 'dotli-core';
const KEY_DB_STORE = 'keys';
const CORE_SECRET_KEY_ID = 'allowance-keys';

/** This site's part of the shared auth store, which every subdomain reaches through the protocol frame. */
export type SharedSessionStore = {
  read(key: string): Promise<string | null>;
  /** Resolves whether the value changed. An equal value is neither written nor told to other tabs. */
  write(key: string, value: string): Promise<boolean>;
  clear(key: string): Promise<void>;
  /** Clears `key` only while it still holds `expected`, in one step on the store. Resolves whether it did. */
  clearIf(key: string, expected: string): Promise<boolean>;
  /** Hears the keys other tabs change. */
  subscribe(listener: (key: string) => void): () => void;
  getStatus(): SharedStoreStatus;
  /** Called on each change only. */
  subscribeStatus(listener: (status: SharedStoreStatus) => void): () => void;
};

/** A read of the saved session, or why the store could not answer it. */
export type SessionRead = { status: 'ok'; blob: string | null } | { status: 'failed'; error: unknown };

/** The saved session as session state reads it. */
export type StoredSession = {
  /** The saved session, or why the store could not answer it. Never rejects, and reports a failed read itself. */
  readSession(): Promise<SessionRead>;
  /** Hears whether each session read failed, a core's or session state's own. */
  subscribeSessionReads(listener: (failed: boolean) => void): () => void;
  /** The cached account, or null for none and for a read that failed. Never throws, and reports its own failure. */
  readUiCache(): Promise<string | null>;
  /** Null clears it. Never throws, and reports its own failure, as the next boot only shows a stale name. */
  writeUiCache(value: string | null): Promise<void>;
  getStatus(): SharedStoreStatus;
  subscribeStatus(listener: (status: SharedStoreStatus) => void): () => void;
  /** A session written in this tab, changed by another tab, or readable again once the store is back. */
  onStoredSessionChanged(listener: () => void): () => void;
  /** Hears each core's write of its session that failed, with the failure. */
  onSessionWriteFailed(listener: (error: unknown) => void): () => void;
};

export type CoreStorageOptions = {
  /**
   * The core keeps its session in memory, so its `AuthSession` slot is a no-op and nothing it does reaches the stored
   * session or the signed-in flag. For a core that must never write either.
   */
  sessionInMemory?: boolean | undefined;
};

export type HostCoreStorage = {
  /** The slots one core reads and writes. Its clear drops only the session it last read or wrote. */
  adapters(options?: CoreStorageOptions): CoreStorage;
  /**
   * Clears the saved session and its cached account only while the session is still `blob`, so a sign-in stored since
   * stays. Resolves whether it did.
   */
  dropSessionIf(blob: string): Promise<boolean>;
  /**
   * Stores a session signed in elsewhere with its cached account, and tells this page's cores and session state, so
   * they pick it up without a reload. A blob equal to the stored one is left as it is, and they are still told, since
   * where the copy is the main store the window wrote it before any of them could follow. Rejects when the store
   * refuses the session.
   */
  installSession(blob: string, uiState: string | null): Promise<void>;
} & StoredSession;

export type CoreStorageDeps = {
  shared: SharedSessionStore;
  /** What every core's session write and clear go through, which moves the signed-in flag as the page's role says. */
  flag: SignInFlag;
  /** This origin's slots. Reached on every call, as the page's localStorage throws where the browser blocks it. */
  local?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Where the at-rest key is kept. */
  keyDb?: () => IDBFactory;
};

export function createCoreStorage({
  shared,
  flag,
  local = () => localStorage,
  keyDb = () => indexedDB,
}: CoreStorageDeps): HostCoreStorage {
  // Writes in this tab, which the shared store's subscription does not report.
  const localChangeListeners = createListenerSet<undefined>({
    onListenerError: reportListener('storage', 'core_storage.local_change'),
  });
  const sessionReadListeners = createListenerSet<boolean>({
    onListenerError: reportListener('storage', 'core_storage.session_read'),
  });
  const sessionWriteFailures = createListenerSet<unknown>({
    onListenerError: reportListener('storage', 'core_storage.session_write'),
  });

  const emitLocalChange = (): void => {
    localChangeListeners.emit(undefined);
  };

  const emitSessionRead = (failed: boolean): void => {
    sessionReadListeners.emit(failed);
  };

  const dropSessionIf = async (blob: string): Promise<boolean> => {
    if (!(await shared.clearIf(SHARED_CORE_SESSION_KEY, blob))) {
      return false;
    }
    await writeUiCache(null);
    emitLocalChange();
    return true;
  };

  const installSession = async (blob: string, uiState: string | null): Promise<void> => {
    // A copy that is the main store already holds the blob, yet may lack the account the window read, so a known
    // account is cached either way. An unknown one clears only the cache of a session this replaced.
    if ((await shared.write(SHARED_CORE_SESSION_KEY, blob)) || uiState !== null) {
      await writeUiCache(uiState);
    }
    emitLocalChange();
  };

  // Hits and misses are counted too, so failures read as a rate. An unreachable shared store is the environment's
  // failure, so it is a breadcrumb rather than an issue.
  const readSession = async (): Promise<SessionRead> => {
    let raw: string | null;
    try {
      raw = await shared.read(SHARED_CORE_SESSION_KEY);
    } catch (error) {
      reportExpected(error, {
        flow: 'storage',
        step: 'session_read',
        metric: S.SHARED_SESSION_READ,
        message: '[dot.li] shared auth session read failed:',
      });
      emitSessionRead(true);
      return { status: 'failed', error };
    }
    const blob = raw === '' ? null : raw;
    m.count(S.SHARED_SESSION_READ, { outcome: blob === null ? 'miss' : 'hit' });
    emitSessionRead(false);
    return { status: 'ok', blob };
  };

  // Null for none and for a read that failed, never a throw, as a read error would make the core clear the stored
  // session, which would log every subdomain out.
  const readSessionBlob = async (): Promise<string | null> => {
    const read = await readSession();
    return read.status === 'ok' ? read.blob : null;
  };

  // One load at a time, and every later call finds the key already loaded.
  const secretKeyLoads = createAsyncTaskPool({ poolSize: 1 });
  let secretKey: CryptoKey | null = null;

  /**
   * A random non-extractable key in IndexedDB, since one derived from bundle data would be computable by anyone.
   * Without IndexedDB it is session-ephemeral, and its values are dropped after a reload.
   */
  const coreSecretStorageKey = (): Promise<CryptoKey> =>
    secretKeyLoads.call(async () => {
      secretKey ??= await loadOrCreateCoreSecretKey(keyDb).catch((err: unknown) => {
        // A browser that refuses IndexedDB, as a private window may, cannot keep the key. Secrets written now will
        // not decrypt after a reload, which is the environment's limit, not a fault.
        reportExpected(err, {
          flow: 'storage',
          step: 'core_secret_key',
          metric: S.CORE_STORAGE_SECRET,
          reason: 'ephemeral_key',
          message: '[dot.li] falling back to a session-ephemeral core-secret storage key:',
        });
        return generateCoreSecretKey();
      });
      return secretKey;
    });

  const encodeCoreStorageValue = async (key: CoreStorageKey, value: Uint8Array): Promise<string> => {
    if (!storesSecretMaterial(key)) {
      return toHex(value);
    }
    const nonce = crypto.getRandomValues(new Uint8Array(CORE_SECRET_NONCE_LENGTH));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await coreSecretStorageKey(), new Uint8Array(value)),
    );
    const stored = new Uint8Array(nonce.length + ciphertext.length);
    stored.set(nonce);
    stored.set(ciphertext, nonce.length);
    return ENCRYPTED_VALUE_PREFIX + toHex(stored);
  };

  const decodeCoreStorageValue = async (key: CoreStorageKey, raw: string): Promise<Uint8Array | undefined> => {
    if (!storesSecretMaterial(key)) {
      return decodeStoredBytes(raw, `core storage ${key.tag}`);
    }
    if (!raw.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      // Slots from before at-rest encryption hold plain bytes, so re-persist them encrypted.
      const bytes = decodeStoredBytes(raw, `core storage ${key.tag}`);
      if (bytes === undefined) {
        return undefined;
      }
      log.event('re-encrypting legacy plaintext core storage', { flow: 'wallet', slot: key.tag });
      local().setItem(coreLocalStorageKey(key), await encodeCoreStorageValue(key, bytes));
      return bytes;
    }
    const bytes = decodeStoredBytes(raw.slice(ENCRYPTED_VALUE_PREFIX.length), `core storage ${key.tag}`);
    if (bytes === undefined) {
      return undefined;
    }
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.slice(0, CORE_SECRET_NONCE_LENGTH) },
          await coreSecretStorageKey(),
          bytes.slice(CORE_SECRET_NONCE_LENGTH),
        ),
      );
    } catch (err) {
      // Written under a key we no longer hold, or corrupt. Returning the raw bytes would hand
      // ciphertext to the core as key material.
      reportExpected(err, {
        flow: 'storage',
        step: 'core_secret_decrypt',
        metric: S.CORE_STORAGE_SECRET,
        reason: 'undecryptable',
        message: `[dot.li] dropping undecryptable core storage ${key.tag}:`,
      });
      local().removeItem(coreLocalStorageKey(key));
      return undefined;
    }
  };

  const readCoreStorageValue = async (key: CoreStorageKey): Promise<Uint8Array | undefined> => {
    const raw = local().getItem(coreLocalStorageKey(key));
    return raw === null ? undefined : await decodeCoreStorageValue(key, raw);
  };

  // An unreachable shared store is the environment's failure, so it is a breadcrumb rather than an issue.
  const reportUiCacheFailure = (op: 'read' | 'write' | 'clear', err: unknown): void => {
    reportExpected(err, {
      flow: 'storage',
      step: 'ui_cache',
      metric: S.SHARED_SESSION_UI_CACHE,
      reason: op,
      message: `[dot.li] session UI cache ${op} failed:`,
    });
  };

  const readUiCache = async (): Promise<string | null> => {
    try {
      return await shared.read(UI_STATE_CACHE_KEY);
    } catch (err) {
      reportUiCacheFailure('read', err);
      return null;
    }
  };

  const writeUiCache = async (value: string | null): Promise<void> => {
    try {
      if (value === null) {
        await shared.clear(UI_STATE_CACHE_KEY);
      } else {
        await shared.write(UI_STATE_CACHE_KEY, value);
      }
    } catch (err) {
      reportUiCacheFailure(value === null ? 'clear' : 'write', err);
    }
  };

  /** The `AuthSession` slot of one core, which drops only the session it last read or wrote. */
  const sessionSlot = () => {
    let held: string | null = null;
    return {
      async read(): Promise<Uint8Array | undefined> {
        held = await readSessionBlob();
        return held === null ? undefined : decodeStoredBytes(held, 'shared auth session');
      },
      async write(value: Uint8Array): Promise<void> {
        const blob = toHex(value);
        try {
          await flag.store(async () => {
            const changed = await shared.write(SHARED_CORE_SESSION_KEY, blob);
            held = blob;
            if (changed) {
              emitLocalChange();
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
          await flag.clear(() => dropSessionIf(blob));
        }
      },
    };
  };

  return {
    adapters({ sessionInMemory = false } = {}) {
      const session = sessionInMemory ? null : sessionSlot();
      return {
        async readCoreStorage(key) {
          if (key.tag === 'AuthSession') {
            return session?.read();
          }
          return readCoreStorageValue(key);
        },
        async writeCoreStorage(key, value) {
          if (key.tag === 'AuthSession') {
            await session?.write(value);
            return;
          }
          local().setItem(coreLocalStorageKey(key), await encodeCoreStorageValue(key, value));
        },
        async clearCoreStorage(key) {
          if (key.tag === 'AuthSession') {
            await session?.clear();
            return;
          }
          local().removeItem(coreLocalStorageKey(key));
        },
      };
    },
    dropSessionIf,
    installSession,
    readSession,
    subscribeSessionReads: listener => sessionReadListeners.subscribe(listener),
    onSessionWriteFailed: listener => sessionWriteFailures.subscribe(listener),
    readUiCache,
    writeUiCache,
    getStatus: () => shared.getStatus(),
    subscribeStatus: listener => shared.subscribeStatus(listener),
    onStoredSessionChanged(listener) {
      const unsubscribeLocal = localChangeListeners.subscribe(() => {
        listener();
      });
      const unsubscribeShared = shared.subscribe(key => {
        if (key === SHARED_CORE_SESSION_KEY) {
          listener();
        }
      });
      let lastStatus = shared.getStatus();
      const unsubscribeStatus = shared.subscribeStatus(status => {
        const recovered = lastStatus === 'unavailable' && status === 'available';
        lastStatus = status;
        // A core whose own read failed holds no session, so the store coming back is a change for it.
        if (recovered) {
          listener();
        }
      });
      return () => {
        unsubscribeLocal();
        unsubscribeShared();
        unsubscribeStatus();
      };
    },
  };
}

/** The protocol frame's shared auth store, scoped to this site. */
function siteSharedSessionStore(): SharedSessionStore {
  return {
    read: key => protocolClient().readSharedAuthStorage(SITE_ID, key),
    write: (key, value) => protocolClient().writeSharedAuthStorage(SITE_ID, key, value),
    clear: key => protocolClient().clearSharedAuthStorage(SITE_ID, key),
    clearIf: (key, expected) => protocolClient().clearSharedAuthStorageIf(SITE_ID, key, expected),
    subscribe: listener =>
      protocolClient().subscribeSharedAuthStorage(change => {
        if (change.tag === 'session' && change.value.siteId === SITE_ID) {
          listener(change.value.key);
        }
      }),
    getStatus: () => protocolClient().getSharedStoreStatus(),
    subscribeStatus: listener => protocolClient().subscribeSharedStoreStatus(listener),
  };
}

/** What the page's copy holds, as the page's flag keeper reads it after a write or a clear. Records a failed read. */
async function storedSignIn(): Promise<StoredSignIn> {
  const [session, wallet] = await Promise.all([
    coreStorage.readSession(),
    siteWallet.read().then(
      (read): StoredSignIn => (read.status === 'ok' ? 'held' : 'none'),
      (error: unknown): StoredSignIn => {
        recordExpected(error, { flow: 'wallet', step: 'presence_wallet_read' });
        return 'unread';
      },
    ),
  ]);
  if ((session.status === 'ok' && session.blob !== null) || wallet === 'held') {
    return 'held';
  }
  return session.status === 'failed' || wallet === 'unread' ? 'unread' : 'none';
}

/**
 * The page's sign-in flag keeper, which the page's role picks. Every keeper renews a flag that is still set. The
 * owner's, on the sign-in window, a preview opened on its own and the landing page, raises the flag with each sign-in
 * it stores and drops it once the store holds none. Any other page's deletes it with a session its core drops, raising
 * it again only for a sign-in stored meanwhile.
 */
export const signInFlag: SignInFlag = createPageSignInFlag({
  role: pageRole,
  presence: sessionPresence,
  storedSignIn,
});

/** The page's one core storage, so a write by one core reaches every other core's listener. */
export const coreStorage: HostCoreStorage = createCoreStorage({
  shared: siteSharedSessionStore(),
  flag: signInFlag,
});

export function onStoredSessionChanged(listener: () => void): () => void {
  return coreStorage.onStoredSessionChanged(listener);
}

function decodeStoredBytes(raw: string, description: string): Uint8Array | undefined {
  try {
    return fromHex(raw);
  } catch (err) {
    log.warn(`[dot.li] ignoring corrupt ${description}:`, err);
    return undefined;
  }
}

function coreLocalStorageKey(key: CoreStorageKey): string {
  switch (key.tag) {
    case 'PairingDeviceIdentity':
      return `${CORE_LOCAL_STORAGE_PREFIX}pairing-device-identity`;
    case 'PermissionAuthorization':
      return `${CORE_LOCAL_STORAGE_PREFIX}permission:${hexNoPrefix(encodeCoreStorageKey(key))}`;
    case 'AllowanceKeys':
      return `${CORE_LOCAL_STORAGE_PREFIX}allowance-keys:${key.value.sessionId}`;
    case 'AutoSigningKey':
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing:${hexNoPrefix(encodeCoreStorageKey(key))}`;
    // One slot for the active pairing, unlike the per-product `AutoSigningKey`.
    case 'AutoSigningKeys':
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing-keys`;
    // Keyed by root public key so several rings coexist. The snapshot is public, so not secret material.
    case 'RingVrfRegistry':
      return `${CORE_LOCAL_STORAGE_PREFIX}ring-vrf-registry:${hexNoPrefix(encodeCoreStorageKey(key))}`;
    case 'StatementRenewalTargets':
      return `${CORE_LOCAL_STORAGE_PREFIX}statement-renewal-targets`;
    case 'LastProcessedPairingStatement':
      return `${CORE_LOCAL_STORAGE_PREFIX}last-processed-pairing-statement`;
    case 'AuthSession':
      return `${CORE_LOCAL_STORAGE_PREFIX}auth-session`;
    // Peers address this device by the public counterpart, so the slot must not move with the session.
    case 'DeviceEncryptionKey':
      return `${CORE_LOCAL_STORAGE_PREFIX}device-encryption-key`;
    // Keyed by session too, since pairing again re-asks the Account Holder.
    case 'ProductSubtree':
      return `${CORE_LOCAL_STORAGE_PREFIX}product-subtree:${hexNoPrefix(encodeCoreStorageKey(key))}`;
    // The ledger bounds replays for one wallet and peer pair, so the whole triple keys the slot.
    case 'SsoResponderRequestLedger':
      return `${CORE_LOCAL_STORAGE_PREFIX}sso-responder-ledger:${hexNoPrefix(encodeCoreStorageKey(key))}`;
    // Per product, so one product's revoked grant expires without touching the others.
    case 'ProductManifest':
      return `${CORE_LOCAL_STORAGE_PREFIX}product-manifest:${key.value.productId}`;
  }
}

function storesSecretMaterial(key: CoreStorageKey): boolean {
  return (
    key.tag === 'AllowanceKeys' ||
    key.tag === 'AutoSigningKey' ||
    key.tag === 'AutoSigningKeys' ||
    key.tag === 'DeviceEncryptionKey'
  );
}

function generateCoreSecretKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function loadOrCreateCoreSecretKey(keyDb: () => IDBFactory): Promise<CryptoKey> {
  const db = await openKeyDb(keyDb());
  try {
    const existing = await idbGetKey(db);
    if (existing !== undefined) {
      return existing;
    }
    const key = await generateCoreSecretKey();
    try {
      await idbAddKey(db, key);
      return key;
    } catch (err) {
      // add() rejects when another tab won the race, so adopt its key rather than split the install.
      const winner = await idbGetKey(db);
      if (winner !== undefined) {
        return winner;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

function openKeyDb(factory: IDBFactory): Promise<IDBDatabase> {
  return openIdb(factory, KEY_DB_NAME, 1, db => {
    db.createObjectStore(KEY_DB_STORE);
  });
}

async function idbGetKey(db: IDBDatabase): Promise<CryptoKey | undefined> {
  const value: unknown = await idbRequest(
    db.transaction(KEY_DB_STORE).objectStore(KEY_DB_STORE).get(CORE_SECRET_KEY_ID),
  );
  return isCryptoKey(value) ? value : undefined;
}

/** Rejects when another tab added the key first, and on a commit-time abort such as a full quota. */
function idbAddKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return idbTransaction(db, KEY_DB_STORE, 'readwrite', tx => {
    tx.objectStore(KEY_DB_STORE).add(key, CORE_SECRET_KEY_ID);
  });
}

/** `instanceof CryptoKey` is unreliable across realms and the global is missing under happy-dom. */
function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof value === 'object' && value !== null && (value as CryptoKey).type === 'secret';
}

function hexNoPrefix(bytes: Uint8Array): string {
  return toHex(bytes).slice(2);
}
