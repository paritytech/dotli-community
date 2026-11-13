// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalWalletStore, type LocalWalletStore } from './localWallet.js';
import { LocalWalletUnreadableError } from './localWalletUnreadableError.js';
import { createMemoryWalletIdb, type MemoryIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let store: LocalWalletStore;

beforeEach(() => {
  idb = createMemoryWalletIdb();
  store = createLocalWalletStore({ idb });
});

const ENTROPY = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const OTHER_ENTROPY = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);
const IDENTITY = { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' };

async function readRawRecord(): Promise<Record<string, unknown> | undefined> {
  const db = await idb.connect();
  return new Promise((resolve, reject) => {
    const request = db.transaction('local_wallet', 'readonly').objectStore('local_wallet').get('wallet');
    request.onsuccess = () => {
      // The store keeps one plain object under this key, and the test reads its fields by name.
      resolve(request.result as Record<string, unknown> | undefined);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('read failed'));
    };
  });
}

async function replaceKey(): Promise<void> {
  const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const record = await readRawRecord();
  const db = await idb.connect();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('local_wallet', 'readwrite');
    transaction.objectStore('local_wallet').put({ ...record, key: other });
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('write failed'));
    };
  });
}

describe('local wallet record', () => {
  it('As a user, I load back the entropy I saved, with no identity yet', async () => {
    // Given
    await store.save(ENTROPY, null);

    // When
    const wallet = await store.load();

    // Then
    expect(wallet).toMatchObject({ entropy: ENTROPY, identity: null });
  });

  it('As a user without a local wallet, I load nothing', async () => {
    // Given: no record

    // When
    const wallet = await store.load();

    // Then
    expect(wallet).toBeNull();
  });

  it('As a user, I keep the identity the network reported beside the entropy', async () => {
    // Given
    await store.save(ENTROPY, null);

    // When
    await store.updateIdentity(IDENTITY);

    // Then
    expect(await store.load()).toMatchObject({ entropy: ENTROPY, identity: IDENTITY });
  });

  it('As a user importing a new phrase, I drop the identity of the old one', async () => {
    // Given
    await store.save(ENTROPY, null);
    await store.updateIdentity(IDENTITY);

    // When
    await store.save(OTHER_ENTROPY, null);

    // Then
    expect(await store.load()).toMatchObject({ entropy: OTHER_ENTROPY, identity: null });
  });

  it('As a user who switched back to Polkadot App, I am not given the wallet back by a late identity update', async () => {
    // Given
    await store.save(ENTROPY, null);
    await store.forget();

    // When
    await store.updateIdentity(IDENTITY);

    // Then
    expect(await store.load()).toBeNull();
  });

  it('As a user, I never have my entropy stored in the clear or under an exportable key', async () => {
    // Given
    await store.save(ENTROPY, null);

    // When
    const record = await readRawRecord();

    // Then the ciphertext and key, which a save writes as an ArrayBuffer and a CryptoKey, hide the entropy
    expect(new Uint8Array(record?.['ciphertext'] as ArrayBuffer)).not.toEqual(ENTROPY);
    expect((record?.['key'] as CryptoKey).extractable).toBe(false);
  });

  it('As a user whose record no longer decrypts, I get an unreadable error naming that record', async () => {
    // Given
    await store.save(ENTROPY, null);
    const saved = await store.load();
    await replaceKey();

    // When
    const load = store.load();

    // Then
    await expect(load).rejects.toEqual(expect.objectContaining({ version: saved?.version }));
    await expect(load).rejects.toBeInstanceOf(LocalWalletUnreadableError);
  });

  it('As a page dropping a wallet signed out elsewhere, I forget the wallet I read', async () => {
    // Given a stored wallet the page read
    await store.save(ENTROPY, null);
    const read = await store.load();

    // When the page forgets it if it is still that record
    const forgot = await store.forgetIf(read?.version ?? new Uint8Array());

    // Then it is forgotten
    expect(forgot).toBe(true);
    expect(await store.load()).toBeNull();
  });

  it('As a page dropping a dead wallet, I still forget the record I read after an identity was cached on it', async () => {
    // Given a wallet the page read, whose identity was cached since
    await store.save(ENTROPY, null);
    const read = await store.load();
    await store.updateIdentity(IDENTITY);

    // When the page forgets it if it is still that record
    const forgot = await store.forgetIf(read?.version ?? new Uint8Array());

    // Then it is forgotten
    expect(forgot).toBe(true);
  });

  it('As a page dropping a dead wallet, I keep a wallet another tab imports after my read', async () => {
    // Given a wallet the page read, replaced by another tab's import
    await store.save(ENTROPY, null);
    const read = await store.load();
    await store.save(OTHER_ENTROPY, null);

    // When the page forgets it if it is still that record
    const forgot = await store.forgetIf(read?.version ?? new Uint8Array());

    // Then nothing is forgotten and the new wallet stays
    expect(forgot).toBe(false);
    expect(await store.load()).toMatchObject({ entropy: OTHER_ENTROPY, identity: null });
  });

  it('As a page dropping a dead wallet, I keep the same phrase imported again after my read', async () => {
    // Given a wallet the page read, imported again since
    await store.save(ENTROPY, null);
    const read = await store.load();
    await store.save(ENTROPY, null);

    // When the page forgets it if it is still that record
    const forgot = await store.forgetIf(read?.version ?? new Uint8Array());

    // Then nothing is forgotten and the wallet stays
    expect(forgot).toBe(false);
    expect(await store.load()).toMatchObject({ entropy: ENTROPY });
  });

  it('As a page dropping a dead wallet, I forget nothing when there is none', async () => {
    // Given: no record

    // When the page forgets a record when none is stored
    const forgot = await store.forgetIf(Uint8Array.of(1, 2, 3));

    // Then nothing is forgotten
    expect(forgot).toBe(false);
  });
});
