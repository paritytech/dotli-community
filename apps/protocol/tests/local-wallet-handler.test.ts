// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_ID } from '@dotli/config';
import type {
  ProtocolRequestEnvelope,
  ProtocolRequestMap,
  SharedWalletRequestMethod,
  WalletOwner,
} from '@dotli/protocol';
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

const owner = { handle: vi.fn(), onRevoked: vi.fn(), releaseAll: vi.fn() } satisfies WalletOwner;
const changed = vi.fn();

function handle(envelope: ProtocolRequestEnvelope, origin: string): Promise<unknown> {
  return handleLocalWalletRequest(envelope, origin, { owner: () => owner, changed });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await forgetLocalWallet();
});

describe('handleLocalWalletRequest', () => {
  it('As a host page with no local wallet, I read none', async () => {
    // Given: no record

    // When
    const result = await handle(request('localWalletRead', { siteId: SITE_ID }), HOST);

    // Then
    expect(result).toEqual({ status: 'none' });
  });

  it('As a host page, I read back the entropy another app saved', async () => {
    // Given
    await handle(request('localWalletSave', { siteId: SITE_ID, entropy: ENTROPY }), HOST);

    // When
    const result = await handle(request('localWalletRead', { siteId: SITE_ID }), HOST);

    // Then
    expect(result).toEqual({ status: 'ok', entropy: ENTROPY, identity: null });
  });

  it('As a host page, I cache the identity and read it back with the entropy', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    await handle(request('localWalletIdentity', { siteId: SITE_ID, identity: IDENTITY }), HOST);

    // Then
    expect(await loadLocalWallet()).toEqual({ entropy: ENTROPY, identity: IDENTITY });
  });

  it('As a host page switching back to Polkadot App, I forget the wallet for every app', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    await handle(request('localWalletForget', { siteId: SITE_ID }), HOST);

    // Then
    expect(await loadLocalWallet()).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('As a host page, I tell sibling tabs about a save but not about an identity update', async () => {
    // When
    await handle(request('localWalletSave', { siteId: SITE_ID, entropy: ENTROPY }), HOST);
    await handle(request('localWalletIdentity', { siteId: SITE_ID, identity: IDENTITY }), HOST);

    // Then
    expect(changed).toHaveBeenCalledOnce();
  });

  it('As a host page booting the local wallet, I ask the frame owner for the lease within my deadline', async () => {
    // Given
    owner.handle.mockResolvedValue('lease-1');
    const envelope = {
      ...request('localWalletOwner', { siteId: SITE_ID, operation: { action: 'acquire' } }),
      deadlineMs: 42,
    };

    // When
    const lease = await handle(envelope, HOST);

    // Then
    expect(lease).toBe('lease-1');
    expect(owner.handle).toHaveBeenCalledWith({ action: 'acquire' }, 42);
  });

  it('As a host page, I cannot send a malformed owner operation', async () => {
    // When
    const result = handle(
      request('localWalletOwner', {
        siteId: SITE_ID,
        operation: { action: 'release' } as ProtocolRequestMap['localWalletOwner']['operation'],
      }),
      HOST,
    );

    // Then
    await expect(result).rejects.toThrow(/owner operation/);
    expect(owner.handle).not.toHaveBeenCalled();
  });

  it('As a product origin, I am refused the wallet', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    const read = handle(request('localWalletRead', { siteId: SITE_ID }), PRODUCT);

    // Then
    await expect(read).rejects.toThrow(/denied/);
  });

  it('As a page on another root domain, I am refused the wallet', async () => {
    // Given
    await saveLocalWallet(ENTROPY);

    // When
    const read = handle(request('localWalletRead', { siteId: 'evil.li' }), HOST);

    // Then
    await expect(read).rejects.toThrow(/Invalid siteId/);
  });

  it('As a host page, I cannot save bytes that are not BIP-39 entropy', async () => {
    // Given
    const entropy = new Uint8Array(5);

    // When
    const save = handle(request('localWalletSave', { siteId: SITE_ID, entropy }), HOST);

    // Then
    await expect(save).rejects.toThrow(/entropy/);
    expect(await loadLocalWallet()).toBeNull();
  });

  it('As a host page, I read an undecryptable wallet as unreadable and it is gone afterwards', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    await corruptRecord();

    // When
    const result = await handle(request('localWalletRead', { siteId: SITE_ID }), HOST);

    // Then
    expect(result).toEqual({ status: 'unreadable' });
    expect(await loadLocalWallet()).toBeNull();
  });
});
