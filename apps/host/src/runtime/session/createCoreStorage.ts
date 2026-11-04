// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core's storage slots. The session blob and its UI-state cache live in the shared store, so every subdomain sees
// one session. Every other slot lives in this origin's localStorage, with secrets encrypted at rest.

import { SITE_ID } from '@dotli/config';
import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorage, CoreStorageKey } from '@parity/truapi-host';
import { SHARED_CORE_SESSION_KEY, getProtocolClient, type SharedStoreStatus } from '@dotli/protocol';
import { m, reportExpected, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  fromHex,
  waitForIdbRequest,
  runIdbTransaction,
  log,
  openIdb,
  toHex,
} from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { pageRole } from '../pageRole.js';
import { sessionPresence } from './createPagePresence.js';
import { createPageSignInFlag, type SignInFlag, type StoredSignIn } from './signInFlag.js';
import { recordPresenceWalletReadFailure, siteWallet } from './siteWallet.js';

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
  /** This origin's slots. Reached on every call, as the page's localStorage throws where the browser blocks it. */
  local?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Where the at-rest key is kept. */
  keyDb?: () => IDBFactory;
};

const CORE_LOCAL_STORAGE_PREFIX = 'dotli:core:';

// Beside the opaque session blob, so the account reads without decoding the blob.
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;

// Legacy plaintext slots are bare hex, so a decrypt failure never falls back to treating ciphertext as plaintext.
const ENCRYPTED_VALUE_PREFIX = 'enc1:';

// A fresh nonce per write, since GCM security collapses if a key and nonce pair is ever reused.
const CORE_SECRET_NONCE_LENGTH = 12;

const KEY_DB_NAME = 'dotli-core';
const KEY_DB_STORE = 'keys';
const CORE_SECRET_KEY_ID = 'allowance-keys';

export function createCoreStorage({ shared, flag, local = () => localStorage, keyDb = () => indexedDB }: Params) {
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

  function emitLocalChange(): void {
    localChangeListeners.emit(undefined);
  }

  function emitSessionRead(failed: boolean): void {
    sessionReadListeners.emit(failed);
  }

  async function dropSessionIf(blob: string): Promise<boolean> {
    if (!(await shared.clearIf(SHARED_CORE_SESSION_KEY, blob))) {
      return false;
    }
    await writeUiCache(null);
    emitLocalChange();
    return true;
  }

  async function installSession(blob: string, uiState: string | null): Promise<void> {
    // A copy that is the main store already holds the blob, yet may lack the account the window read, so a known
    // account is cached either way. An unknown one clears only the cache of a session this replaced.
    if ((await shared.write(SHARED_CORE_SESSION_KEY, blob)) || uiState !== null) {
      await writeUiCache(uiState);
    }
    emitLocalChange();
  }

  // Hits and misses are counted too, so failures read as a rate. An unreachable shared store is the environment's
  // failure, so it is a breadcrumb rather than an issue.
  async function readSession(): Promise<SessionRead> {
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
  }

  // Null for none and for a read that failed, never a throw, as a read error would make the core clear the stored
  // session, which would log every subdomain out.
  async function readSessionBlob(): Promise<string | null> {
    const read = await readSession();
    return read.status === 'ok' ? read.blob : null;
  }

  // One load at a time, and every later call finds the key already loaded.
  const secretKeyLoads = createAsyncTaskPool({ poolSize: 1 });
  let secretKey: CryptoKey | null = null;

  /**
   * A random non-extractable key in IndexedDB, since one derived from bundle data would be computable by anyone.
   * Without IndexedDB it is session-ephemeral, and its values are dropped after a reload.
   */
  function getCoreSecretStorageKey(): Promise<CryptoKey> {
    return secretKeyLoads.call(async () => {
      secretKey ??= await loadOrCreateCoreSecretKey(keyDb).catch((error: unknown) => {
        // A browser that refuses IndexedDB, as a private window may, cannot keep the key. Secrets written now will
        // not decrypt after a reload, which is the environment's limit, not a fault.
        reportExpected(error, {
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
  }

  async function encodeCoreStorageValue(key: CoreStorageKey, value: Uint8Array): Promise<string> {
    if (!isSecretMaterialSlot(key)) {
      return toHex(value);
    }
    const nonce = crypto.getRandomValues(new Uint8Array(CORE_SECRET_NONCE_LENGTH));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        await getCoreSecretStorageKey(),
        new Uint8Array(value),
      ),
    );
    const stored = new Uint8Array(nonce.length + ciphertext.length);
    stored.set(nonce);
    stored.set(ciphertext, nonce.length);
    return ENCRYPTED_VALUE_PREFIX + toHex(stored);
  }

  async function decodeCoreStorageValue(key: CoreStorageKey, raw: string): Promise<Uint8Array | undefined> {
    if (!isSecretMaterialSlot(key)) {
      return decodeStoredBytes(raw, `core storage ${key.tag}`);
    }
    if (!raw.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      // Slots from before at-rest encryption hold plain bytes, so re-persist them encrypted.
      const bytes = decodeStoredBytes(raw, `core storage ${key.tag}`);
      if (bytes === undefined) {
        return undefined;
      }
      log.event('re-encrypting legacy plaintext core storage', { flow: 'wallet', slot: key.tag });
      local().setItem(getCoreLocalStorageKey(key), await encodeCoreStorageValue(key, bytes));
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
          await getCoreSecretStorageKey(),
          bytes.slice(CORE_SECRET_NONCE_LENGTH),
        ),
      );
    } catch (error) {
      // Written under a key we no longer hold, or corrupt. Returning the raw bytes would hand
      // ciphertext to the core as key material.
      reportExpected(error, {
        flow: 'storage',
        step: 'core_secret_decrypt',
        metric: S.CORE_STORAGE_SECRET,
        reason: 'undecryptable',
        message: `[dot.li] dropping undecryptable core storage ${key.tag}:`,
      });
      local().removeItem(getCoreLocalStorageKey(key));
      return undefined;
    }
  }

  async function readCoreStorageValue(key: CoreStorageKey): Promise<Uint8Array | undefined> {
    const raw = local().getItem(getCoreLocalStorageKey(key));
    return raw === null ? undefined : await decodeCoreStorageValue(key, raw);
  }

  // An unreachable shared store is the environment's failure, so it is a breadcrumb rather than an issue.
  function reportUiCacheFailure(operation: 'read' | 'write' | 'clear', error: unknown): void {
    reportExpected(error, {
      flow: 'storage',
      step: 'ui_cache',
      metric: S.SHARED_SESSION_UI_CACHE,
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
          await flag.clear({ drop: () => dropSessionIf(blob) });
        }
      },
    };
  }

  function subscribeStoredSession(listener: () => void): () => void {
    const unsubscribeLocal = localChangeListeners.subscribe(() => {
      listener();
    });
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
          return readCoreStorageValue(key);
        },
        async writeCoreStorage(key, value) {
          if (key.tag === 'AuthSession') {
            await session?.write(value);
            return;
          }
          local().setItem(getCoreLocalStorageKey(key), await encodeCoreStorageValue(key, value));
        },
        async clearCoreStorage(key) {
          if (key.tag === 'AuthSession') {
            await session?.clear();
            return;
          }
          local().removeItem(getCoreLocalStorageKey(key));
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
    subscribeSessionReads: (listener: (failed: boolean) => void): (() => void) =>
      sessionReadListeners.subscribe(listener),
    /** Hears each core's write of its session that failed, with the failure. Returns the unsubscribe. */
    subscribeSessionWriteFailures: (listener: (error: unknown) => void): (() => void) =>
      sessionWriteFailures.subscribe(listener),
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

function decodeStoredBytes(raw: string, description: string): Uint8Array | undefined {
  try {
    return fromHex(raw);
  } catch (error) {
    reportExpected(error, {
      flow: 'storage',
      step: 'core_decode',
      metric: S.CORE_STORAGE_READ,
      reason: 'corrupt',
      message: `[dot.li] ignoring corrupt ${description}:`,
    });
    return undefined;
  }
}

function getCoreLocalStorageKey(key: CoreStorageKey): string {
  switch (key.tag) {
    case 'PairingDeviceIdentity':
      return `${CORE_LOCAL_STORAGE_PREFIX}pairing-device-identity`;
    case 'PermissionAuthorization':
      return `${CORE_LOCAL_STORAGE_PREFIX}permission:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    case 'AllowanceKeys':
      return `${CORE_LOCAL_STORAGE_PREFIX}allowance-keys:${key.value.sessionId}`;
    case 'AutoSigningKey':
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    // One slot for the active pairing, unlike the per-product `AutoSigningKey`.
    case 'AutoSigningKeys':
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing-keys`;
    // Keyed by root public key so several rings coexist. The snapshot is public, so not secret material.
    case 'RingVrfRegistry':
      return `${CORE_LOCAL_STORAGE_PREFIX}ring-vrf-registry:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
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
      return `${CORE_LOCAL_STORAGE_PREFIX}product-subtree:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    // The ledger bounds replays for one wallet and peer pair, so the whole triple keys the slot.
    case 'SsoResponderRequestLedger':
      return `${CORE_LOCAL_STORAGE_PREFIX}sso-responder-ledger:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    // Per product, so one product's revoked grant expires without touching the others.
    case 'ProductManifest':
      return `${CORE_LOCAL_STORAGE_PREFIX}product-manifest:${key.value.productLabel}`;
  }
}

function isSecretMaterialSlot(key: CoreStorageKey): boolean {
  switch (key.tag) {
    case 'AllowanceKeys':
    case 'AutoSigningKey':
    case 'AutoSigningKeys':
    case 'DeviceEncryptionKey':
      return true;
    case 'PairingDeviceIdentity':
    case 'PermissionAuthorization':
    case 'RingVrfRegistry':
    case 'StatementRenewalTargets':
    case 'LastProcessedPairingStatement':
    case 'AuthSession':
    case 'ProductSubtree':
    case 'SsoResponderRequestLedger':
    case 'ProductManifest':
      return false;
  }
}

function generateCoreSecretKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function loadOrCreateCoreSecretKey(keyDb: () => IDBFactory): Promise<CryptoKey> {
  const database = await openKeyDatabase(keyDb());
  try {
    const existing = await readStoredSecretKey(database);
    if (existing !== undefined) {
      return existing;
    }
    const key = await generateCoreSecretKey();
    try {
      await addStoredSecretKey(database, key);
      return key;
    } catch (error) {
      // add() rejects when another tab won the race, so adopt its key rather than split the install.
      const winner = await readStoredSecretKey(database);
      if (winner !== undefined) {
        return winner;
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

function openKeyDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return openIdb({
    factory,
    name: KEY_DB_NAME,
    version: 1,
    upgrade: database => {
      database.createObjectStore(KEY_DB_STORE);
    },
  });
}

async function readStoredSecretKey(database: IDBDatabase): Promise<CryptoKey | undefined> {
  const value: unknown = await waitForIdbRequest(
    database.transaction(KEY_DB_STORE).objectStore(KEY_DB_STORE).get(CORE_SECRET_KEY_ID),
  );
  return isCryptoKey(value) ? value : undefined;
}

/** Rejects when another tab added the key first, and on a commit-time abort such as a full quota. */
function addStoredSecretKey(database: IDBDatabase, key: CryptoKey): Promise<void> {
  return runIdbTransaction({
    db: database,
    stores: KEY_DB_STORE,
    mode: 'readwrite',
    body: transaction => {
      transaction.objectStore(KEY_DB_STORE).add(key, CORE_SECRET_KEY_ID);
    },
  });
}

/** `instanceof CryptoKey` is unreliable across realms and the global is missing under happy-dom. */
function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof value === 'object' && value !== null && (value as CryptoKey).type === 'secret';
}

function formatHexNoPrefix(bytes: Uint8Array): string {
  return toHex(bytes).slice(2);
}
