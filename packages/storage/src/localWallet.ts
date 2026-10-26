// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The local wallet's root entropy, encrypted at rest under a key this origin can use but never export.

import { walletIdb, type DotliIdb } from './db.js';
import { bytesEqual, idbRequest, idbTransaction } from '@dotli/shared';

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

/** The record exists but its key no longer opens it, so it can never be used again. */
export class LocalWalletUnreadableError extends Error {
  constructor(cause: unknown) {
    super('Local wallet cannot be decrypted', { cause });
    this.name = 'LocalWalletUnreadableError';
  }
}

/** The local wallet over `idb`, the wallet database by default. */
export function createLocalWalletStore(idb: DotliIdb = walletIdb) {
  async function readRecord(): Promise<LocalWalletRecord | undefined> {
    const db = await idb.connect();
    return (await idbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID))) as
      LocalWalletRecord | undefined;
  }

  /** Resolves on commit, so a reload right after never loses the write. */
  async function write(change: (store: IDBObjectStore) => void): Promise<void> {
    const db = await idb.connect();
    await idbTransaction(db, STORE, 'readwrite', tx => {
      change(tx.objectStore(STORE));
    });
  }

  async function saveLocalWallet(entropy: Uint8Array, identity: LocalWalletIdentity | null): Promise<void> {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Uint8Array.from(entropy));
    const record: LocalWalletRecord = { id: RECORD_ID, key, iv, ciphertext, identity };
    await write(store => {
      store.put(record);
    });
  }

  async function loadLocalWallet(): Promise<LocalWallet | null> {
    const record = await readRecord();
    if (record === undefined) {
      return null;
    }
    return { entropy: await decryptRecord(record), identity: record.identity, version: record.iv };
  }

  /**
   * Reads and writes in one transaction, so a forget that commits meanwhile cannot be undone by a put.
   * Without a record, as after a switch back in another tab, there is nothing to update.
   */
  async function updateLocalWalletIdentity(identity: LocalWalletIdentity): Promise<void> {
    const db = await idb.connect();
    await idbTransaction(db, STORE, 'readwrite', tx => {
      const store = tx.objectStore(STORE);
      const req = store.get(RECORD_ID);
      req.onsuccess = () => {
        const record = req.result as LocalWalletRecord | undefined;
        if (record !== undefined) {
          store.put({ ...record, identity });
        }
      };
    });
  }

  async function forgetLocalWallet(): Promise<void> {
    await write(store => {
      store.delete(RECORD_ID);
    });
  }

  /**
   * Forgets the wallet only while it is still the record of `version`, read and deleted in one transaction, so a wallet
   * saved since by another tab stays. Resolves whether it forgot it.
   */
  async function forgetLocalWalletIf(version: Uint8Array): Promise<boolean> {
    let forgot = false;
    const db = await idb.connect();
    await idbTransaction(db, STORE, 'readwrite', tx => {
      const store = tx.objectStore(STORE);
      const req = store.get(RECORD_ID);
      req.onsuccess = () => {
        const current = req.result as LocalWalletRecord | undefined;
        // Every save draws a fresh IV, so the IV is the record's version.
        if (current !== undefined && bytesEqual(current.iv, version)) {
          store.delete(RECORD_ID);
          forgot = true;
        }
      };
    });
    return forgot;
  }

  return { saveLocalWallet, loadLocalWallet, updateLocalWalletIdentity, forgetLocalWallet, forgetLocalWalletIf };
}

export type LocalWalletStore = ReturnType<typeof createLocalWalletStore>;

export const {
  saveLocalWallet,
  loadLocalWallet,
  updateLocalWalletIdentity,
  forgetLocalWallet,
  forgetLocalWalletIf,
}: LocalWalletStore = createLocalWalletStore();

async function decryptRecord(record: LocalWalletRecord): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, record.key, record.ciphertext),
    );
  } catch (error) {
    throw new LocalWalletUnreadableError(error);
  }
}
