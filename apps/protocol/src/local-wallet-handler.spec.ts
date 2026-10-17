// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { createLocalWalletStore, LocalWalletUnreadableError, type LocalWalletStore } from '@dotli/storage';
import { memoryIdb } from '@dotli/storage/testing';
import { serveLocalWallet } from './local-wallet-handler.js';
import { closeHostLinks, HOST_ORIGIN, linkHost, PRODUCT_ORIGIN, type HostLink } from './testing/host-link.js';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const IDENTITY = { identityAccountId: `0x${'22'.repeat(32)}`, liteUsername: 'bob.7' };

// Each test gets a fresh database, so no test sees another's wallet.
let store: LocalWalletStore;

beforeEach(() => {
  store = createLocalWalletStore(memoryIdb());
});

afterEach(closeHostLinks);

function served(origin: string | null = HOST_ORIGIN, wallet: LocalWalletStore = store): HostLink {
  const link = linkHost(origin);
  serveLocalWallet(link.serving, wallet);
  return link;
}

describe('the local wallet', () => {
  it('As a host page with no local wallet, I read none', async () => {
    // Given: no record
    const { host } = served();

    // When
    const result = await host.request('localWalletRead', { siteId: SITE_ID });

    // Then
    expect(result).toEqual({ tag: 'none' });
  });

  it('As a host page, I read back the entropy another app saved', async () => {
    // Given
    const { host } = served();
    await host.request('localWalletSave', { siteId: SITE_ID, entropy: ENTROPY });

    // When
    const result = await host.request('localWalletRead', { siteId: SITE_ID });

    // Then
    expect(result).toEqual({ tag: 'ok', value: { entropy: ENTROPY, identity: null } });
  });

  it('As a host page, I cache the identity and read it back with the entropy', async () => {
    // Given
    const { host } = served();
    await store.saveLocalWallet(ENTROPY);

    // When
    await host.request('localWalletIdentity', { siteId: SITE_ID, identity: IDENTITY });

    // Then
    expect(await store.loadLocalWallet()).toEqual({ entropy: ENTROPY, identity: IDENTITY });
    expect(await host.request('localWalletRead', { siteId: SITE_ID })).toEqual({
      tag: 'ok',
      value: { entropy: ENTROPY, identity: IDENTITY },
    });
  });

  it('As a host page switching back to Polkadot App, I forget the wallet for every app', async () => {
    // Given
    const { host } = served();
    await store.saveLocalWallet(ENTROPY);

    // When
    await host.request('localWalletForget', { siteId: SITE_ID });

    // Then
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a product origin, I am refused the wallet', async () => {
    // Given
    const { host } = served(PRODUCT_ORIGIN);
    await store.saveLocalWallet(ENTROPY);

    // When
    const read = host.request('localWalletRead', { siteId: SITE_ID });

    // Then
    await expect(read).rejects.toThrow(`Local wallet request denied from origin: ${PRODUCT_ORIGIN}`);
  });

  it('As a peer with no origin, I am refused the wallet', async () => {
    // Given
    const { host } = served(null);
    await store.saveLocalWallet(ENTROPY);

    // When
    const forget = host.request('localWalletForget', { siteId: SITE_ID });

    // Then
    await expect(forget).rejects.toThrow('Local wallet request denied from origin: none');
    expect(await store.loadLocalWallet()).not.toBeNull();
  });

  it('As a page on another root domain, I am refused the wallet', async () => {
    // Given
    const { host } = served();
    await store.saveLocalWallet(ENTROPY);

    // When
    const read = host.request('localWalletRead', { siteId: 'evil.li' });

    // Then
    await expect(read).rejects.toThrow(/Invalid siteId/);
  });

  it('As a host page, I cannot save bytes that are not BIP-39 entropy', async () => {
    // Given
    const { host } = served();

    // When
    const save = host.request('localWalletSave', { siteId: SITE_ID, entropy: new Uint8Array(5) });

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
    const { host } = served(HOST_ORIGIN, unreadable);

    // When
    const result = await host.request('localWalletRead', { siteId: SITE_ID });

    // Then
    expect(result).toEqual({ tag: 'unreadable' });
    expect(await store.loadLocalWallet()).toBeNull();
  });
});
