// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Native Chat's private records for the local wallet: the main purse, device records, attachment chunks and the
// product index. One tab of the browser profile holds them at a time, through this frame's Web Lock.

import { CORE_CUSTODY_BUSY_ERROR, localWalletCustodyId, type CoreCustodyOperation } from '@dotli/protocol';
import { loadLocalWallet } from '@dotli/storage';

export const CORE_CUSTODY_DB_NAME = 'dotli-native-core-custody';
const STORE = 'records';
const KEY = 'encryption-key';
const CUSTODY_LOCK = 'dotli:native-core-custody';
/**
 * Long enough for a reloaded or replaced page core to stop and release. A core of another live tab keeps the lock, so
 * this one is refused once the wait runs out.
 */
const CUSTODY_WAIT_MS = 10_000;
interface Lease {
  wallet: string;
  released: Promise<void>;
  release(): void;
}
// The Web Lock admits one at a time; a replacement core of this page queues on it like another tab would.
const leases = new Map<string, Lease>();
let pageActive = true;
let pageLifetime = 0;

// A lease belongs to this host iframe's parent, not to a product or a TTL.
// Page destruction releases Web Locks even if JavaScript never runs cleanup.
window.addEventListener('pagehide', () => {
  pageActive = false;
  pageLifetime++;
  for (const lease of leases.values()) {
    lease.release();
  }
  leases.clear();
});
window.addEventListener('pageshow', () => {
  pageActive = true;
});

/** A forgotten or replaced local wallet ends the lease's authority, so every operation checks the stored record. */
async function assertLocalWallet(wallet: string): Promise<void> {
  const stored = await loadLocalWallet();
  if (stored === null) {
    throw new Error('Private custody requires the local wallet');
  }
  try {
    if ((await localWalletCustodyId(stored.entropy)) !== wallet) {
      throw new Error('The local wallet changed');
    }
  } finally {
    stored.entropy.fill(0);
  }
}

async function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(CORE_CUSTODY_DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  let blocked = false;
  request.onblocked = () => {
    blocked = true;
    reject(new Error('Private custody storage is blocked'));
  };
  request.onerror = () => {
    reject(new Error('Private custody storage is unavailable'));
  };
  request.onsuccess = () => {
    if (blocked) {
      request.result.close();
      return;
    }
    resolve(request.result);
  };
  return promise;
}

function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const tx = db.transaction(STORE, mode, { durability: 'strict' });
  let request: IDBRequest<T>;
  tx.oncomplete = () => {
    resolve(request.result);
  };
  tx.onerror = tx.onabort = () => {
    reject(new Error('Private custody transaction failed'));
  };
  try {
    request = action(tx.objectStore(STORE));
  } catch (error) {
    tx.abort();
    reject(error);
  }
  return promise;
}

export async function handleCoreCustody(
  operation: CoreCustodyOperation,
  deadlineMs?: number,
): Promise<string | Uint8Array | Blob | undefined> {
  if (operation.action === 'acquire') {
    if (!pageActive) {
      throw new Error('Private custody host is inactive');
    }
    if (
      typeof navigator.locks === 'undefined' ||
      typeof crypto.subtle === 'undefined' ||
      typeof globalThis.indexedDB === 'undefined'
    ) {
      throw new Error('Private custody requires Web Locks, Web Crypto and IndexedDB');
    }
    const lifetime = pageLifetime;
    const ready = Promise.withResolvers<string>();
    const released = Promise.withResolvers<undefined>();
    const waitMs = Math.max(
      0,
      Math.min(CUSTODY_WAIT_MS, deadlineMs === undefined ? CUSTODY_WAIT_MS : deadlineMs - Date.now()),
    );
    void navigator.locks
      .request(CUSTODY_LOCK, { signal: AbortSignal.timeout(waitMs) }, async () => {
        const held = Promise.withResolvers<undefined>();
        // Check the wallet and durable storage before giving any runtime custody authority.
        await assertLocalWallet(operation.wallet);
        const db = await openDatabase();
        db.close();
        if (!pageActive || lifetime !== pageLifetime) {
          throw new Error('Private custody host closed while acquiring custody');
        }
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
          throw new Error('Private custody request expired');
        }
        const token = crypto.randomUUID();
        leases.set(token, {
          wallet: operation.wallet,
          released: released.promise,
          release: () => {
            held.resolve(undefined);
          },
        });
        ready.resolve(token);
        await held.promise;
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          const busy = new Error(
            'Chat is open with this local wallet in another tab. Close it there to use Chat here.',
          );
          busy.name = CORE_CUSTODY_BUSY_ERROR;
          ready.reject(busy);
          return;
        }
        ready.reject(error);
      })
      .finally(() => {
        released.resolve(undefined);
      });
    return ready.promise;
  }
  const owner = leases.get(operation.lease);
  if (owner === undefined) {
    throw new Error('Private custody lease is unavailable');
  }
  if (operation.action === 'release') {
    leases.delete(operation.lease);
    owner.release();
    await owner.released;
    return;
  }
  let result: Uint8Array | Blob | undefined;
  await assertLocalWallet(owner.wallet);
  if (leases.get(operation.lease) !== owner) {
    throw new Error('Private custody lease changed');
  }
  const db = await openDatabase();
  try {
    if (operation.action === 'putSources') {
      // IndexedDB commits immutable Blob snapshots without materializing an
      // entire attachment as a JavaScript byte array. No names or paths persist.
      await transaction(db, 'readwrite', store => {
        let last: IDBRequest<IDBValidKey> | undefined;
        for (const source of operation.sources) {
          last = store.add(
            source.blob.slice(0, source.blob.size, 'application/octet-stream'),
            `source:${source.sourceId}`,
          );
        }
        if (!last) {
          throw new Error('No Chat sources supplied');
        }
        return last;
      });
      return;
    }
    if (operation.action === 'readSource') {
      const blob: unknown = await transaction(db, 'readonly', store => store.get(`source:${operation.sourceId}`));
      if (blob !== undefined && !(blob instanceof Blob)) {
        throw new Error('Private Chat source is corrupt');
      }
      return blob;
    }
    if (operation.action === 'releaseSource') {
      await transaction(db, 'readwrite', store => store.delete(`source:${operation.sourceId}`));
      return;
    }
    const storageKey = `core:${operation.key}`;
    if (operation.action === 'clear') {
      await transaction(db, 'readwrite', store => store.delete(storageKey));
      return;
    }
    const storedKey: unknown = await transaction(db, 'readonly', store => store.get(KEY));
    const stored: unknown =
      operation.action === 'read' ? await transaction(db, 'readonly', store => store.get(storageKey)) : undefined;
    if (operation.action === 'read' && stored === undefined) {
      return;
    }
    let key: CryptoKey;
    if (storedKey === undefined) {
      if (operation.action === 'read') {
        throw new Error('Private custody encryption key is missing');
      }
      const existing = await transaction(db, 'readonly', store => store.count(IDBKeyRange.bound('core:', 'core;')));
      if (existing > 0) {
        throw new Error('Private custody encryption key is missing');
      }
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await transaction(db, 'readwrite', store => store.add(key, KEY));
    } else {
      if (
        !(storedKey instanceof CryptoKey) ||
        storedKey.type !== 'secret' ||
        storedKey.algorithm.name !== 'AES-GCM' ||
        storedKey.extractable
      ) {
        throw new Error('Private custody encryption key is invalid');
      }
      key = storedKey;
    }
    const additionalData = new TextEncoder().encode(storageKey);
    if (operation.action === 'read') {
      if (!(stored instanceof Uint8Array) || stored.length < 28) {
        throw new Error('Private custody record is corrupt');
      }
      // Failure is not absence: never delete/recreate an undecryptable purse or device.
      result = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: new Uint8Array(stored.subarray(0, 12)),
            additionalData,
          },
          key,
          new Uint8Array(stored.subarray(12)),
        ),
      );
    } else {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, new Uint8Array(operation.value)),
      );
      const record = new Uint8Array(iv.length + ciphertext.length);
      record.set(iv);
      record.set(ciphertext, iv.length);
      if (leases.get(operation.lease) !== owner) {
        throw new Error('Private custody lease changed');
      }
      await transaction(db, 'readwrite', store => store.put(record, storageKey));
    }
  } finally {
    db.close();
  }
  return result;
}
