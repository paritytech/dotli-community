// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalWalletStore, type LocalWalletStore, LocalWalletUnreadableError } from './local-wallet.js';
import { memoryWalletIdb, type MemoryIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let store: LocalWalletStore;

beforeEach(() => {
  idb = memoryWalletIdb();
  store = createLocalWalletStore(idb);
});

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const OTHER_ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);
const IDENTITY = { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' };

async function rawRecord(): Promise<Record<string, unknown> | undefined> {
  const db = await idb.connect();
  return new Promise((resolve, reject) => {
    const req = db.transaction('local_wallet', 'readonly').objectStore('local_wallet').get('wallet');
    req.onsuccess = () => {
      resolve(req.result as Record<string, unknown> | undefined);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('read failed'));
    };
  });
}

async function replaceKey(): Promise<void> {
  const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const record = await rawRecord();
  const db = await idb.connect();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('local_wallet', 'readwrite');
    tx.objectStore('local_wallet').put({ ...record, key: other });
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('write failed'));
    };
  });
}

describe('local wallet record', () => {
  it('As a user, I load back the entropy I saved, with no identity yet', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY, null);

    // When
    const wallet = await store.loadLocalWallet();

    // Then
    expect(wallet).toMatchObject({ entropy: ENTROPY, identity: null });
  });

  it('As a user without a local wallet, I load nothing', async () => {
    // Given: no record

    // When
    const wallet = await store.loadLocalWallet();

    // Then
    expect(wallet).toBeNull();
  });

  it('As a page, I save a wallet with its identity through the frame and read both back', async () => {
    // Given a wallet saved with its identity
    await store.saveLocalWallet(ENTROPY, IDENTITY);

    // When it is loaded
    const wallet = await store.loadLocalWallet();

    // Then the entropy and identity come back
    expect(wallet).toMatchObject({ entropy: ENTROPY, identity: IDENTITY });
  });

  it('As a user, I keep the identity the network reported beside the entropy', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY, null);

    // When
    await store.updateLocalWalletIdentity(IDENTITY);

    // Then
    expect(await store.loadLocalWallet()).toMatchObject({ entropy: ENTROPY, identity: IDENTITY });
  });

  it('As a user importing a new phrase, I drop the identity of the old one', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY, null);
    await store.updateLocalWalletIdentity(IDENTITY);

    // When
    await store.saveLocalWallet(OTHER_ENTROPY, null);

    // Then
    expect(await store.loadLocalWallet()).toMatchObject({ entropy: OTHER_ENTROPY, identity: null });
  });

  it('As a user who switched back to Polkadot App, I am not given the wallet back by a late identity update', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY, null);
    await store.forgetLocalWallet();

    // When
    await store.updateLocalWalletIdentity(IDENTITY);

    // Then
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a user, I never have my entropy stored in the clear or under an exportable key', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY, null);

    // When
    const record = await rawRecord();

    // Then
    expect(new Uint8Array(record?.['ciphertext'] as ArrayBuffer)).not.toEqual(ENTROPY);
    expect((record?.['key'] as CryptoKey).extractable).toBe(false);
  });

  it('As a user whose record no longer decrypts, I get an unreadable error', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY, null);
    await replaceKey();

    // When
    const load = store.loadLocalWallet();

    // Then
    await expect(load).rejects.toBeInstanceOf(LocalWalletUnreadableError);
  });

  it('As a page dropping a wallet signed out elsewhere, I forget the wallet I read', async () => {
    // Given a stored wallet the page read
    await store.saveLocalWallet(ENTROPY, null);
    const read = await store.loadLocalWallet();

    // When the page forgets it if it is still that record
    const forgot = await store.forgetLocalWalletIf(read?.version ?? new Uint8Array());

    // Then it is forgotten
    expect(forgot).toBe(true);
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a page dropping a dead wallet, I still forget the record I read after an identity was cached on it', async () => {
    // Given a wallet the page read, whose identity was cached since
    await store.saveLocalWallet(ENTROPY, null);
    const read = await store.loadLocalWallet();
    await store.updateLocalWalletIdentity(IDENTITY);

    // When the page forgets it if it is still that record
    const forgot = await store.forgetLocalWalletIf(read?.version ?? new Uint8Array());

    // Then it is forgotten
    expect(forgot).toBe(true);
  });

  it('As a page dropping a dead wallet, I keep a wallet another tab imports after my read', async () => {
    // Given a wallet the page read, replaced by another tab's import
    await store.saveLocalWallet(ENTROPY, null);
    const read = await store.loadLocalWallet();
    await store.saveLocalWallet(OTHER_ENTROPY, null);

    // When the page forgets it if it is still that record
    const forgot = await store.forgetLocalWalletIf(read?.version ?? new Uint8Array());

    // Then nothing is forgotten and the new wallet stays
    expect(forgot).toBe(false);
    expect(await store.loadLocalWallet()).toMatchObject({ entropy: OTHER_ENTROPY, identity: null });
  });

  it('As a page dropping a dead wallet, I keep the same phrase imported again after my read', async () => {
    // Given a wallet the page read, imported again since
    await store.saveLocalWallet(ENTROPY, null);
    const read = await store.loadLocalWallet();
    await store.saveLocalWallet(ENTROPY, null);

    // When the page forgets it if it is still that record
    const forgot = await store.forgetLocalWalletIf(read?.version ?? new Uint8Array());

    // Then nothing is forgotten and the wallet stays
    expect(forgot).toBe(false);
    expect(await store.loadLocalWallet()).toMatchObject({ entropy: ENTROPY });
  });

  it('As a page dropping a dead wallet, I forget nothing when there is none', async () => {
    // Given: no record

    // When the page forgets a record when none is stored
    const forgot = await store.forgetLocalWalletIf(Uint8Array.of(1, 2, 3));

    // Then nothing is forgotten
    expect(forgot).toBe(false);
  });
});
