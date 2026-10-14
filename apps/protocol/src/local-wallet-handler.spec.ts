// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import type { ProtocolRequestEnvelope, ProtocolRequestMap, SharedWalletRequestMethod } from '@dotli/protocol';
import { createLocalWalletStore, LocalWalletUnreadableError, type LocalWalletStore } from '@dotli/storage';
import { memoryIdb } from '@dotli/storage/testing';
import { handleLocalWalletRequest } from './local-wallet-handler.js';

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

// Each test gets a fresh database, so no test sees another's wallet.
let store: LocalWalletStore;

beforeEach(() => {
  store = createLocalWalletStore(memoryIdb());
});

describe('handleLocalWalletRequest', () => {
  it('As a host page with no local wallet, I read none', async () => {
    // Given: no record

    // When
    const result = await handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), HOST, store);

    // Then
    expect(result).toEqual({ status: 'none' });
  });

  it('As a host page, I read back the entropy another app saved', async () => {
    // Given
    await handleLocalWalletRequest(request('localWalletSave', { siteId: SITE_ID, entropy: ENTROPY }), HOST, store);

    // When
    const result = await handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), HOST, store);

    // Then
    expect(result).toEqual({ status: 'ok', entropy: ENTROPY, identity: null });
  });

  it('As a host page, I cache the identity and read it back with the entropy', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY);

    // When
    await handleLocalWalletRequest(
      request('localWalletIdentity', { siteId: SITE_ID, identity: IDENTITY }),
      HOST,
      store,
    );

    // Then
    expect(await store.loadLocalWallet()).toEqual({ entropy: ENTROPY, identity: IDENTITY });
  });

  it('As a host page switching back to Polkadot App, I forget the wallet for every app', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY);

    // When
    await handleLocalWalletRequest(request('localWalletForget', { siteId: SITE_ID }), HOST, store);

    // Then
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a product origin, I am refused the wallet', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY);

    // When
    const read = handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), PRODUCT, store);

    // Then
    await expect(read).rejects.toThrow(/denied/);
  });

  it('As a page on another root domain, I am refused the wallet', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY);

    // When
    const read = handleLocalWalletRequest(request('localWalletRead', { siteId: 'evil.li' }), HOST, store);

    // Then
    await expect(read).rejects.toThrow(/Invalid siteId/);
  });

  it('As a host page, I cannot save bytes that are not BIP-39 entropy', async () => {
    // Given
    const entropy = new Uint8Array(5);

    // When
    const save = handleLocalWalletRequest(request('localWalletSave', { siteId: SITE_ID, entropy }), HOST, store);

    // Then
    await expect(save).rejects.toThrow(/entropy/);
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a host page, I read an undecryptable wallet as unreadable and it is gone afterwards', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY);
    const unreadable: LocalWalletStore = {
      ...store,
      loadLocalWallet: () => Promise.reject(new LocalWalletUnreadableError(new Error('wrong key'))),
    };

    // When
    const result = await handleLocalWalletRequest(request('localWalletRead', { siteId: SITE_ID }), HOST, unreadable);

    // Then
    expect(result).toEqual({ status: 'unreadable' });
    expect(await store.loadLocalWallet()).toBeNull();
  });
});
