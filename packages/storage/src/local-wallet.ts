// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The local wallet's root entropy, encrypted at rest under a key this origin can use but never export.

import { getDb } from './db.js';

const STORE = 'local_wallet';
const RECORD_ID = 'wallet';
const IV_BYTES = 12;

export interface LocalWalletIdentity {
  identityAccountId: string;
  /** Null when the network holds no lite username for the account. */
  liteUsername: string | null;
}

export interface LocalWallet {
  entropy: Uint8Array;
  /** The identity last read from the network, null until the first read. */
  identity: LocalWalletIdentity | null;
}

interface LocalWalletRecord {
  id: typeof RECORD_ID;
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
  identity: LocalWalletIdentity | null;
}

/** The record exists but its key no longer opens it, so it can never be used again. */
export class LocalWalletUnreadableError extends Error {
  constructor(cause: unknown) {
    super('Local wallet cannot be decrypted', { cause });
    this.name = 'LocalWalletUnreadableError';
  }
}

async function readRecord(): Promise<LocalWalletRecord | undefined> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID);
    req.onsuccess = () => {
      resolve(req.result as LocalWalletRecord | undefined);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('local wallet read failed'));
    };
  });
}

/** Resolves on commit, so a reload right after never loses the write. */
async function write(change: (store: IDBObjectStore) => void): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    change(tx.objectStore(STORE));
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('local wallet write failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('local wallet write aborted'));
    };
  });
}

export async function saveLocalWallet(entropy: Uint8Array): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Uint8Array.from(entropy));
  const record: LocalWalletRecord = { id: RECORD_ID, key, iv, ciphertext, identity: null };
  await write(store => {
    store.put(record);
  });
}

export async function loadLocalWallet(): Promise<LocalWallet | null> {
  const record = await readRecord();
  if (record === undefined) {
    return null;
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, record.key, record.ciphertext);
  } catch (error) {
    throw new LocalWalletUnreadableError(error);
  }
  return { entropy: new Uint8Array(plain), identity: record.identity };
}

/**
 * Reads and writes in one transaction, so a forget that commits meanwhile cannot be undone by a put.
 * Without a record, as after a switch back in another tab, there is nothing to update.
 */
export async function updateLocalWalletIdentity(identity: LocalWalletIdentity): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(RECORD_ID);
    req.onsuccess = () => {
      const record = req.result as LocalWalletRecord | undefined;
      if (record !== undefined) {
        store.put({ ...record, identity });
      }
    };
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('local wallet identity update failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('local wallet identity update aborted'));
    };
  });
}

export async function forgetLocalWallet(): Promise<void> {
  await write(store => {
    store.delete(RECORD_ID);
  });
}
