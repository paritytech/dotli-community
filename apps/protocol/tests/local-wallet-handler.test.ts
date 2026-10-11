// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import type { ProtocolRequestEnvelope, ProtocolRequestMap, SharedWalletRequestMethod } from '@dotli/protocol';
import { forgetLocalWallet, loadLocalWallet, saveLocalWallet } from '@dotli/storage';
import { handleLocalWalletRequest } from '../src/local-wallet-handler.js';

const HOST = 'http://host-playground.localhost:5173';
const PRODUCT = 'http://bafy.app.localhost:5173';
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const IDENTITY = { identityAccountId: `0x${'22'.repeat(32)}`, liteUsername: 'bob.7' };

function request<M extends SharedWalletRequestMethod>(
  method: M,
  payload: ProtocolRequestMap[M],
): ProtocolRequestEnvelope<M> {
  return { namespace: 'dotli:protocol', kind: 'request', id: 'req-1', method, payload };
}

/** Swaps in a key that cannot open the stored ciphertext. */
async function corruptRecord(): Promise<void> {
  const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('dotli');
    open.onsuccess = () => {
      resolve(open.result);
    };
    open.onerror = () => {
      reject(open.error ?? new Error('open failed'));
    };
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('local_wallet', 'readwrite');
    const store = tx.objectStore('local_wallet');
    const get = store.get('wallet');
    get.onsuccess = () => {
      store.put({ ...(get.result as object), key: other });
    };
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('write failed'));
    };
  });
  db.close();
}

beforeEach(async () => {
  await forgetLocalWallet();
});

describe('handleLocalWalletRequest', () => {
  it('As a host page with no local wallet, I read none', async () => {
    // Given: no record

    // When
    const result = await handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), HOST);

    // Then
    expect(result).toEqual({ status: 'none' });
  });

  it('As a host page, I read back the entropy another app saved', async () => {
    // Given
    await handleLocalWalletRequest(request('localWalletSave', { siteId: SITE_ID, entropy: ENTROPY }), HOST);

    // When
    const result = await handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), HOST);

    // Then
    expect(result).toEqual({ status: 'ok', entropy: ENTROPY, identity: null });
  });

  it('As a host page, I cache the identity and read it back with the entropy', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    await handleLocalWalletRequest(request('localWalletIdentity', { siteId: SITE_ID, identity: IDENTITY }), HOST);

    // Then
    expect(await loadLocalWallet()).toEqual({ entropy: ENTROPY, identity: IDENTITY });
  });

  it('As a host page switching back to Polkadot App, I forget the wallet for every app', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    await handleLocalWalletRequest(request('localWalletForget', { siteId: SITE_ID }), HOST);

    // Then
    expect(await loadLocalWallet()).toBeNull();
  });

  it('As a product origin, I am refused the wallet', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    const read = handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), PRODUCT);

    // Then
    await expect(read).rejects.toThrow(/denied/);
  });

  it('As a page on another root domain, I am refused the wallet', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    const read = handleLocalWalletRequest(request('localWalletRead', { siteId: 'evil.li' }), HOST);

    // Then
    await expect(read).rejects.toThrow(/Invalid siteId/);
  });

  it('As a host page, I cannot save bytes that are not BIP-39 entropy', async () => {
    // Given
    const entropy = new Uint8Array(5);

    // When
    const save = handleLocalWalletRequest(request('localWalletSave', { siteId: SITE_ID, entropy }), HOST);

    // Then
    await expect(save).rejects.toThrow(/entropy/);
    expect(await loadLocalWallet()).toBeNull();
  });

  it('As a host page, I read an undecryptable wallet as unreadable and it is gone afterwards', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    await corruptRecord();

    // When
    const result = await handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), HOST);

    // Then
    expect(result).toEqual({ status: 'unreadable' });
    expect(await loadLocalWallet()).toBeNull();
  });
});
