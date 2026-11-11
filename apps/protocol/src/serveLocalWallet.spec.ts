// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { protocolSchema } from '@dotli/protocol';
import { createLocalWalletStore, LocalWalletUnreadableError, type LocalWalletStore } from '@dotli/storage';
import { createMemoryWalletIdb } from '@dotli/storage/testing';
import { err, hostFailure, ok, unsupported, type MethodTypes } from '@dotli/transport';
import { serveLocalWallet } from './serveLocalWallet.js';
import { closeHostLinks, linkHost, type HostLink } from './testing/linkHost.js';

afterEach(closeHostLinks);

const { wallet } = protocolSchema.sections;

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const IDENTITY = { identityAccountId: `0x${'22'.repeat(32)}`, liteUsername: 'bob.7' };

// Each test gets a fresh database, so no test sees another's wallet.
let store: LocalWalletStore;

beforeEach(() => {
  store = createLocalWalletStore({ idb: createMemoryWalletIdb() });
});

/** The version a wallet read answered with, empty for an answer that holds no wallet. */
function readVersion(read: MethodTypes<typeof wallet.read>['response']): Uint8Array {
  return read.success && read.value.tag === 'ok' ? read.value.value.version : new Uint8Array();
}

/** The sites whose wallet record a served call changed, in order. */
let walletChanges: string[];

beforeEach(() => {
  walletChanges = [];
});

function serveWallet(walletStore: LocalWalletStore = store): HostLink & { stop: () => void } {
  const link = linkHost();
  const stop = serveLocalWallet({
    serving: link.serving,
    onChange: siteId => {
      walletChanges.push(siteId);
    },
    store: walletStore,
  });
  return { ...link, stop };
}

describe('the local wallet', () => {
  it('As a host page with no local wallet, I read the wallet and get none', async () => {
    // Given no record
    const { host } = serveWallet();

    // When
    const result = await host.request(wallet.read, { siteId: SITE_ID });

    // Then
    expect(result).toEqual(ok({ tag: 'none', value: undefined }));
  });

  it('As a host page, I save a wallet with its identity and read both back', async () => {
    // Given a wallet saved with its identity
    const { host } = serveWallet();
    await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: IDENTITY });

    // When the wallet is read
    const result = await host.request(wallet.read, { siteId: SITE_ID });

    // Then it carries the entropy and the identity
    expect(result).toMatchObject(ok({ tag: 'ok', value: { entropy: ENTROPY, identity: IDENTITY } }));
  });

  it('As a host page, I cache the identity and read it back with the entropy', async () => {
    // Given
    const { host } = serveWallet();
    await store.save(ENTROPY, null);

    // When the identity is cached, and the wallet read back
    await host.request(wallet.identity, { siteId: SITE_ID, identity: IDENTITY });
    const read = await host.request(wallet.read, { siteId: SITE_ID });

    // Then
    expect(await store.load()).toMatchObject({ entropy: ENTROPY, identity: IDENTITY });
    expect(read).toMatchObject(ok({ tag: 'ok', value: { entropy: ENTROPY, identity: IDENTITY } }));
  });

  it('As a host page switching back to Polkadot App, I forget the wallet and it is gone for every app', async () => {
    // Given
    const { host } = serveWallet();
    await store.save(ENTROPY, null);

    // When
    await host.request(wallet.forget, { siteId: SITE_ID });

    // Then
    expect(await store.load()).toBeNull();
  });

  it('As a page dropping a dead wallet, I forget the wallet I read and it is gone', async () => {
    // Given a stored wallet the page read
    const { host } = serveWallet();
    await store.save(ENTROPY, null);
    const read = await host.request(wallet.read, { siteId: SITE_ID });

    // When the page forgets it if it is still the record it read
    const forgot = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: readVersion(read) });

    // Then it is forgotten
    expect(forgot).toEqual(ok(true));
    expect(await store.load()).toBeNull();
  });

  it('As a page dropping a dead wallet, I forget the wallet I read and keep the same phrase imported again since', async () => {
    // Given my read of the dead wallet, then another tab's import of the same phrase
    const { host } = serveWallet();
    await store.save(ENTROPY, null);
    const read = await host.request(wallet.read, { siteId: SITE_ID });
    await store.save(ENTROPY, null);

    // When the page forgets it if it is still the record it read
    const forgot = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: readVersion(read) });

    // Then nothing is forgotten and the wallet stays
    expect(forgot).toEqual(ok(false));
    expect(await store.load()).toMatchObject({ entropy: ENTROPY, identity: null });
  });

  it('As a host page in another tab, I am told each time a save or a forget changed the wallet record, and only then', async () => {
    // Given a served wallet store
    const { host } = serveWallet();

    // When a save, an identity, a forget that misses the record, one of the record read, and a save and a plain forget
    await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: null });
    await host.request(wallet.identity, { siteId: SITE_ID, identity: IDENTITY });
    const missed = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: new Uint8Array(12) });
    const read = await host.request(wallet.read, { siteId: SITE_ID });
    const forgot = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: readVersion(read) });
    await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: null });
    await host.request(wallet.forget, { siteId: SITE_ID });

    // Then only the forget that missed was not broadcast
    expect(missed).toEqual(ok(false));
    expect(forgot).toEqual(ok(true));
    expect(walletChanges).toEqual([SITE_ID, SITE_ID, SITE_ID, SITE_ID]);
  });

  it('As a page on another root domain, I read the wallet and am refused', async () => {
    // Given
    const { host } = serveWallet();
    await store.save(ENTROPY, null);

    // When
    const read = host.request(wallet.read, { siteId: 'evil.li' });

    // Then
    await expect(read).resolves.toEqual(err(hostFailure('Error: Invalid siteId: evil.li')));
  });

  it('As a host page, I save bytes that are not BIP-39 entropy and am refused', async () => {
    // Given
    const { host } = serveWallet();

    // When
    const save = host.request(wallet.save, { siteId: SITE_ID, entropy: new Uint8Array(5), identity: null });

    // Then
    await expect(save).resolves.toEqual(err(hostFailure('Error: Invalid local wallet entropy')));
    expect(await store.load()).toBeNull();
  });

  it('As a host page, I read an undecryptable wallet as unreadable and it is gone afterwards', async () => {
    // Given
    await store.save(ENTROPY, null);
    const unreadable: LocalWalletStore = {
      ...store,
      load: () => Promise.reject(new LocalWalletUnreadableError(new Error('wrong key'))),
    };
    const { host } = serveWallet(unreadable);

    // When
    const result = await host.request(wallet.read, { siteId: SITE_ID });

    // Then
    expect(result).toEqual(ok({ tag: 'unreadable', value: undefined }));
    expect(await store.load()).toBeNull();
  });

  it('As a frame that stopped serving the wallet, I answer no more wallet calls', async () => {
    // Given a served wallet that answered a read
    const { host, stop } = serveWallet();
    const served = await host.request(wallet.read, { siteId: SITE_ID });

    // When the frame stops serving the wallet
    stop();
    const refused = await host.request(wallet.read, { siteId: SITE_ID });
    const saved = await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: null });

    // Then the next calls are refused as unserved methods, and nothing was saved
    expect(served).toEqual(ok({ tag: 'none', value: undefined }));
    expect(refused).toEqual(err(unsupported()));
    expect(saved).toEqual(err(unsupported()));
    expect(await store.load()).toBeNull();
    expect(walletChanges).toEqual([]);
  });
});
