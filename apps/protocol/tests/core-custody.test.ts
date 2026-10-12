// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_CUSTODY_BUSY_ERROR, isCoreCustodyOperation, localWalletCustodyId } from '@dotli/protocol';
import { forgetLocalWallet, saveLocalWallet } from '@dotli/storage';
import { handleCoreCustody } from '../src/core-custody.js';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const OTHER_ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);
// A `MainPurseCoinage`-shaped custody key; the frame treats keys as opaque hex.
const PURSE_KEY = `0b${'07'.repeat(32)}${'08'.repeat(32)}`;

/** One exclusive lock per name, granted in request order, with the abort signal the frame bounds its wait by. */
function installWebLocks(): void {
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request(name: string, options: { signal?: AbortSignal }, callback: (lock: object) => Promise<void>) {
        const previous = tails.get(name) ?? Promise.resolve();
        const { promise: done, resolve: finish } = Promise.withResolvers<undefined>();
        tails.set(
          name,
          previous.then(() => done),
        );
        return new Promise<void>((resolve, reject) => {
          let granted = false;
          options.signal?.addEventListener('abort', () => {
            if (!granted) {
              reject(new DOMException('Lock request aborted', 'AbortError'));
            }
          });
          void previous.then(async () => {
            if (options.signal?.aborted === true) {
              finish(undefined);
              return;
            }
            granted = true;
            await callback({})
              .then(resolve, reject)
              .finally(() => {
                finish(undefined);
              });
          });
        });
      },
    },
  });
}

async function acquire(entropy = ENTROPY, deadlineMs?: number): Promise<string> {
  const lease = await handleCoreCustody({ action: 'acquire', wallet: await localWalletCustodyId(entropy) }, deadlineMs);
  if (typeof lease !== 'string') {
    throw new Error('Custody was not acquired');
  }
  return lease;
}

beforeAll(() => {
  installWebLocks();
});

beforeEach(async () => {
  await forgetLocalWallet();
});

describe('native Chat custody under the local wallet', () => {
  it('As a local wallet core, I keep a private record across leases and lose access once I release', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    const first = await acquire();

    // When
    await handleCoreCustody({ action: 'write', lease: first, key: PURSE_KEY, value: new Uint8Array([1, 2, 3]) });
    await handleCoreCustody({ action: 'release', lease: first });

    // Then
    await expect(handleCoreCustody({ action: 'read', lease: first, key: PURSE_KEY })).rejects.toThrow(
      'Private custody lease is unavailable',
    );
    const replacement = await acquire();
    await expect(handleCoreCustody({ action: 'read', lease: replacement, key: PURSE_KEY })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await handleCoreCustody({ action: 'clear', lease: replacement, key: PURSE_KEY });
    await expect(handleCoreCustody({ action: 'read', lease: replacement, key: PURSE_KEY })).resolves.toBeUndefined();
    await handleCoreCustody({ action: 'release', lease: replacement });
  });

  it('As a host page without a local wallet, I cannot take custody', async () => {
    await expect(acquire()).rejects.toThrow('Private custody requires the local wallet');
  });

  it('As a page booted on one wallet, I cannot take custody of a replacement wallet', async () => {
    // Given: the frame now stores a different wallet than the page booted
    await saveLocalWallet(OTHER_ENTROPY);

    // Then
    await expect(acquire(ENTROPY)).rejects.toThrow('The local wallet changed');
  });

  it('As a lease holder, I lose authority when the local wallet is forgotten', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    const lease = await acquire();

    // When
    await forgetLocalWallet();

    // Then
    await expect(
      handleCoreCustody({ action: 'write', lease, key: PURSE_KEY, value: new Uint8Array([9]) }),
    ).rejects.toThrow('Private custody requires the local wallet');
    await handleCoreCustody({ action: 'release', lease });
  });

  it('As a replacement core, I wait for the previous holder to release', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    const first = await acquire();

    // When
    const waiting = acquire();
    await handleCoreCustody({ action: 'release', lease: first });

    // Then
    const second = await waiting;
    expect(second).not.toBe(first);
    await handleCoreCustody({ action: 'release', lease: second });
  });

  it('As a second tab, I am refused as busy while another holder keeps custody', async () => {
    // Given
    await saveLocalWallet(ENTROPY);
    const holder = await acquire();

    // When: the request budget runs out before the holder releases
    const refused = acquire(ENTROPY, Date.now() + 50);

    // Then
    await expect(refused).rejects.toMatchObject({ name: CORE_CUSTODY_BUSY_ERROR });
    await handleCoreCustody({ action: 'release', lease: holder });
  });
});

describe('isCoreCustodyOperation', () => {
  it('accepts an acquire only for a 32-byte wallet custody id', async () => {
    expect(isCoreCustodyOperation({ action: 'acquire', wallet: await localWalletCustodyId(ENTROPY) })).toBe(true);
    expect(isCoreCustodyOperation({ action: 'acquire', wallet: 'ab' })).toBe(false);
    expect(isCoreCustodyOperation({ action: 'acquire', walletRevision: null })).toBe(false);
  });
});
