// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db.js';
import {
  forgetLocalWallet,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
} from '../src/local-wallet.js';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const OTHER_ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);
const IDENTITY = { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' };

async function rawRecord(): Promise<Record<string, unknown> | undefined> {
  const db = await getDb();
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
  const db = await getDb();
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

beforeEach(async () => {
  await forgetLocalWallet();
});

describe('local wallet record', () => {
  it('As a user, I load back the entropy I saved, with no identity yet', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    const wallet = await loadLocalWallet();

    // Then
    expect(wallet).toEqual({ entropy: ENTROPY, identity: null });
  });

  it('As a user without a local wallet, I load nothing', async () => {
    // Given: no record

    // When
    const wallet = await loadLocalWallet();

    // Then
    expect(wallet).toBeNull();
  });

  it('As a user, I keep the identity the network reported beside the entropy', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    await updateLocalWalletIdentity(IDENTITY);

    // Then
    expect(await loadLocalWallet()).toEqual({ entropy: ENTROPY, identity: IDENTITY });
  });

  it('As a user importing a new phrase, I drop the identity of the old one', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    await updateLocalWalletIdentity(IDENTITY);

    // When
    await saveLocalWallet(OTHER_ENTROPY);

    // Then
    expect(await loadLocalWallet()).toEqual({ entropy: OTHER_ENTROPY, identity: null });
  });

  it('As a user who switched back to Polkadot App, I am not given the wallet back by a late identity update', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    await forgetLocalWallet();

    // When
    await updateLocalWalletIdentity(IDENTITY);

    // Then
    expect(await loadLocalWallet()).toBeNull();
  });

  it('As a user, I never have my entropy stored in the clear or under an exportable key', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    const record = await rawRecord();

    // Then
    expect(new Uint8Array(record?.['ciphertext'] as ArrayBuffer)).not.toEqual(ENTROPY);
    expect((record?.['key'] as CryptoKey).extractable).toBe(false);
  });

  it('As a user whose record no longer decrypts, I get an unreadable error', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    await replaceKey();

    // When
    const load = loadLocalWallet();

    // Then
    await expect(load).rejects.toBeInstanceOf(LocalWalletUnreadableError);
  });
});
