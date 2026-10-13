// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core's storage slots. The session blob and its UI-state cache live in the shared store, so every subdomain sees
// one session. Every other slot lives in this origin's localStorage, with secrets encrypted at rest.

import { SITE_ID } from '@dotli/config';
import { bytesToHex, hexToBytes } from '@parity/truapi/scale';
import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorage, CoreStorageKey } from '@parity/truapi-host';
import {
  SHARED_CORE_SESSION_KEY,
  clearSharedAuthStorage,
  getSharedStoreStatus,
  readSharedAuthStorage,
  subscribeSharedAuthStorage,
  subscribeSharedStoreStatus,
  writeSharedAuthStorage,
  type SharedStoreStatus,
} from '@dotli/protocol';
import { m, reportExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, log } from '@dotli/shared';

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
export interface SharedSessionStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
  /** Hears the keys other tabs change. */
  subscribe(listener: (key: string) => void): () => void;
  getStatus(): SharedStoreStatus;
  /** Called on each change only. */
  subscribeStatus(listener: (status: SharedStoreStatus) => void): () => void;
}

/** The saved session as session state reads it. */
export interface StoredSession {
  /**
   * The saved session blob, or null for none and for a read that failed. Never throws, as the core clears the stored
   * session after a read error, which would log every subdomain out.
   */
  readSession(): Promise<string | null>;
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
}

export interface CoreStorageOptions {
  /**
   * A local wallet core holds its session in memory, so its `AuthSession` slot is a no-op. The paired session stays
   * as it was for the switch back.
   */
  local?: boolean | undefined;
}

export interface HostCoreStorage extends StoredSession {
  /** The slots one core reads and writes. */
  adapters(options?: CoreStorageOptions): CoreStorage;
}

export interface CoreStorageDeps {
  shared: SharedSessionStore;
  /** This origin's slots. Reached on every call, as the page's localStorage throws where the browser blocks it. */
  local?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Where the at-rest key is kept. */
  keyDb?: () => IDBFactory;
}

export function createCoreStorage({
  shared,
  local = () => localStorage,
  keyDb = () => indexedDB,
}: CoreStorageDeps): HostCoreStorage {
  // Writes in this tab, which the shared store's subscription does not report.
  const localChangeListeners = new Set<() => void>();
  const sessionReadListeners = new Set<(failed: boolean) => void>();

  const emitLocalChange = (): void => {
    for (const listener of [...localChangeListeners]) {
      listener();
    }
  };

  const emitSessionRead = (failed: boolean): void => {
    for (const listener of [...sessionReadListeners]) {
      listener(failed);
    }
  };

  // Hits and misses are counted too, so failures read as a rate. An unreachable shared store is the environment's
  // failure, so it is a breadcrumb rather than an issue.
  const readSession = async (): Promise<string | null> => {
    let raw: string | null;
    try {
      raw = await shared.read(SHARED_CORE_SESSION_KEY);
    } catch (err) {
      reportExpected(err, {
        flow: 'storage',
        step: 'session_read',
        metric: S.SHARED_SESSION_READ,
        message: '[dot.li] shared auth session read failed:',
      });
      emitSessionRead(true);
      return null;
    }
    const blob = raw === '' ? null : raw;
    m.count(S.SHARED_SESSION_READ, { outcome: blob === null ? 'miss' : 'hit' });
    emitSessionRead(false);
    return blob;
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
        log.warn('[dot.li] falling back to a session-ephemeral core-secret storage key:', err);
        return generateCoreSecretKey();
      });
      return secretKey;
    });

  const encodeCoreStorageValue = async (key: CoreStorageKey, value: Uint8Array): Promise<string> => {
    if (!storesSecretMaterial(key)) {
      return bytesToHex(value);
    }
    const nonce = crypto.getRandomValues(new Uint8Array(CORE_SECRET_NONCE_LENGTH));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await coreSecretStorageKey(), new Uint8Array(value)),
    );
    const stored = new Uint8Array(nonce.length + ciphertext.length);
    stored.set(nonce);
    stored.set(ciphertext, nonce.length);
    return ENCRYPTED_VALUE_PREFIX + bytesToHex(stored);
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
      log.warn(`[dot.li] dropping undecryptable core storage ${key.tag}:`, err);
      local().removeItem(coreLocalStorageKey(key));
      return undefined;
    }
  };

  const readCoreStorageValue = async (key: CoreStorageKey): Promise<Uint8Array | undefined> => {
    if (key.tag === 'AuthSession') {
      const raw = await readSession();
      return raw === null ? undefined : decodeStoredBytes(raw, 'shared auth session');
    }
    const raw = local().getItem(coreLocalStorageKey(key));
    return raw === null ? undefined : await decodeCoreStorageValue(key, raw);
  };

  const writeCoreStorageValue = async (key: CoreStorageKey, value: Uint8Array): Promise<void> => {
    if (key.tag === 'AuthSession') {
      await shared.write(SHARED_CORE_SESSION_KEY, bytesToHex(value));
      emitLocalChange();
      return;
    }
    local().setItem(coreLocalStorageKey(key), await encodeCoreStorageValue(key, value));
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

  const clearCoreStorageValue = async (key: CoreStorageKey): Promise<void> => {
    if (key.tag === 'AuthSession') {
      await shared.clear(SHARED_CORE_SESSION_KEY);
      await writeUiCache(null);
      emitLocalChange();
      return;
    }
    local().removeItem(coreLocalStorageKey(key));
  };

  return {
    adapters(options = {}) {
      const skips = (key: CoreStorageKey): boolean => options.local === true && key.tag === 'AuthSession';
      return {
        async readCoreStorage(key) {
          return skips(key) ? undefined : readCoreStorageValue(key);
        },
        async writeCoreStorage(key, value) {
          if (!skips(key)) {
            await writeCoreStorageValue(key, value);
          }
        },
        async clearCoreStorage(key) {
          if (!skips(key)) {
            await clearCoreStorageValue(key);
          }
        },
      };
    },
    readSession,
    subscribeSessionReads(listener) {
      // Wrapped, so one listener subscribed twice is two subscriptions, as each unsubscribe expects.
      const onRead = (failed: boolean): void => {
        listener(failed);
      };
      sessionReadListeners.add(onRead);
      return () => {
        sessionReadListeners.delete(onRead);
      };
    },
    readUiCache,
    writeUiCache,
    getStatus: () => shared.getStatus(),
    subscribeStatus: listener => shared.subscribeStatus(listener),
    onStoredSessionChanged(listener) {
      const onLocalChange = (): void => {
        listener();
      };
      localChangeListeners.add(onLocalChange);
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
        localChangeListeners.delete(onLocalChange);
        unsubscribeShared();
        unsubscribeStatus();
      };
    },
  };
}

/** The protocol frame's shared auth store, scoped to this site. */
function siteSharedSessionStore(): SharedSessionStore {
  return {
    read: key => readSharedAuthStorage(SITE_ID, key),
    write: (key, value) => writeSharedAuthStorage(SITE_ID, key, value),
    clear: key => clearSharedAuthStorage(SITE_ID, key),
    subscribe: listener =>
      subscribeSharedAuthStorage(change => {
        if (change.siteId === SITE_ID) {
          listener(change.key);
        }
      }),
    getStatus: getSharedStoreStatus,
    subscribeStatus: subscribeSharedStoreStatus,
  };
}

/** The page's one core storage, so a write by one core reaches every other core's listener. */
export const coreStorage: HostCoreStorage = createCoreStorage({ shared: siteSharedSessionStore() });

export function onStoredSessionChanged(listener: () => void): () => void {
  return coreStorage.onStoredSessionChanged(listener);
}

function decodeStoredBytes(raw: string, description: string): Uint8Array | undefined {
  try {
    return hexToBytes(raw);
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
  return new Promise((resolve, reject) => {
    const request = factory.open(KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(KEY_DB_STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexedDB open failed'));
    };
  });
}

function idbGetKey(db: IDBDatabase): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(KEY_DB_STORE).objectStore(KEY_DB_STORE).get(CORE_SECRET_KEY_ID);
    request.onsuccess = () => {
      const value: unknown = request.result;
      resolve(isCryptoKey(value) ? value : undefined);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexedDB get failed'));
    };
  });
}

function idbAddKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_DB_STORE, 'readwrite');
    tx.objectStore(KEY_DB_STORE).add(key, CORE_SECRET_KEY_ID);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('indexedDB add failed'));
    };
    // A commit-time abort such as QuotaExceededError fires only `abort`, and the key load would otherwise hang every
    // read and write for the session.
    tx.onabort = () => {
      reject(tx.error ?? new Error('indexedDB add aborted'));
    };
  });
}

/** `instanceof CryptoKey` is unreliable across realms and the global is missing under happy-dom. */
function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof value === 'object' && value !== null && (value as CryptoKey).type === 'secret';
}

function hexNoPrefix(bytes: Uint8Array): string {
  return bytesToHex(bytes).slice(2);
}
