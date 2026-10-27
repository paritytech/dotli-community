// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The local wallet's root entropy, encrypted at rest under a key this origin can use but never export.

import { walletIdb, type DotliIdb } from './db.js';
import { LocalWalletUnreadableError } from './localWalletUnreadableError.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { areBytesEqual, waitForIdbRequest, runIdbTransaction } from '@dotli/shared';

const STORE = 'local_wallet';
const RECORD_ID = 'wallet';
const IV_BYTES = 12;

export type LocalWalletIdentity = {
  identityAccountId: string;
  /** Null when the network holds no lite username for the account. */
  liteUsername: string | null;
};

export type LocalWallet = {
  entropy: Uint8Array;
  /** The identity last read from the network, null until the first read. */
  identity: LocalWalletIdentity | null;
  /** Changes with every save and never with an identity update, so a forget can name the record it read. */
  version: Uint8Array;
};

type LocalWalletRecord = {
  id: typeof RECORD_ID;
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
  identity: LocalWalletIdentity | null;
};

type Params = {
  /** The database the wallet lives in. */
  idb?: DotliIdb;
};

/**
 * The local wallet over `idb`, the wallet database by default. Every member rejects when the database fails, and `load`
 * also rejects as its own entry says.
 */
export function createLocalWalletStore({ idb = walletIdb }: Params = {}) {
  async function readRecord(): Promise<LocalWalletRecord | undefined> {
    const db = await idb.connect();
    return unsafe_readStoredRecord<LocalWalletRecord | undefined>(
      await waitForIdbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID)),
    );
  }

  /** Resolves on commit, so a reload right after never loses the write. */
  async function write(change: (store: IDBObjectStore) => void): Promise<void> {
    const db = await idb.connect();
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        change(transaction.objectStore(STORE));
      },
    });
  }

  async function save(entropy: Uint8Array, identity: LocalWalletIdentity | null): Promise<void> {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Uint8Array.from(entropy));
    const record: LocalWalletRecord = { id: RECORD_ID, key, iv, ciphertext, identity };
    await write(store => {
      store.put(record);
    });
  }

  async function load(): Promise<LocalWallet | null> {
    const record = await readRecord();
    if (record === undefined) {
      return null;
    }
    return { entropy: await decryptRecord(record), identity: record.identity, version: record.iv };
  }

  // Reads and writes in one transaction, so a forget that commits meanwhile cannot be undone by a put.
  async function updateIdentity(identity: LocalWalletIdentity): Promise<void> {
    const db = await idb.connect();
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        const store = transaction.objectStore(STORE);
        const request = store.get(RECORD_ID);
        request.onsuccess = () => {
          const record = unsafe_readStoredRecord<LocalWalletRecord | undefined>(request.result);
          if (record !== undefined) {
            store.put({ ...record, identity });
          }
        };
      },
    });
  }

  async function forget(): Promise<void> {
    await write(store => {
      store.delete(RECORD_ID);
    });
  }

  async function forgetIf(version: Uint8Array): Promise<boolean> {
    let forgot = false;
    const db = await idb.connect();
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        const store = transaction.objectStore(STORE);
        const request = store.get(RECORD_ID);
        request.onsuccess = () => {
          const current = unsafe_readStoredRecord<LocalWalletRecord | undefined>(request.result);
          // Every save draws a fresh IV, so the IV is the record's version.
          if (current !== undefined && areBytesEqual(current.iv, version)) {
            store.delete(RECORD_ID);
            forgot = true;
          }
        };
      },
    });
    return forgot;
  }

  return {
    /** Encrypts `entropy` under a fresh key and IV and stores it with `identity`. Resolves on commit. */
    save,
    /**
     * Resolves the wallet, or null when none is stored. Rejects with `LocalWalletUnreadableError` when the record
     * cannot be decrypted.
     */
    load,
    /**
     * Sets the stored identity and keeps the version. Without a record, as after a switch back in another tab, there is
     * nothing to update.
     */
    updateIdentity,
    /** Removes the wallet, and does nothing when none is stored. */
    forget,
    /**
     * Forgets the wallet only while it is still the record of `version`, read and deleted in one transaction, so a wallet
     * saved since by another tab stays. Resolves whether it forgot it.
     */
    forgetIf,
  };
}

export type LocalWalletStore = ReturnType<typeof createLocalWalletStore>;

/** The frame's local wallet, in its own database. */
export const localWallet = createLocalWalletStore();

async function decryptRecord(record: LocalWalletRecord): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, record.key, record.ciphertext),
    );
  } catch (error) {
    throw new LocalWalletUnreadableError(error);
  }
}
