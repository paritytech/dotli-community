// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Chat attachment sources are Blobs in IndexedDB, which fake-indexeddb cannot store, so these run in real Chromium.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localWalletCustodyId } from '@dotli/protocol';
import { forgetLocalWallet, saveLocalWallet } from '@dotli/storage';
import { CORE_CUSTODY_DB_NAME, handleCoreCustody } from '../../src/core-custody.js';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

let lease: string | undefined;

async function acquire(): Promise<string> {
  const token = await handleCoreCustody({ action: 'acquire', wallet: await localWalletCustodyId(ENTROPY) });
  if (typeof token !== 'string') {
    throw new Error('Custody was not acquired');
  }
  lease = token;
  return token;
}

async function readSource(token: string, sourceId: string): Promise<Uint8Array | undefined> {
  const source = await handleCoreCustody({ action: 'readSource', lease: token, sourceId });
  if (source === undefined) {
    return undefined;
  }
  if (!(source instanceof Blob)) {
    throw new Error('Custody returned a non-Blob source');
  }
  return new Uint8Array(await source.arrayBuffer());
}

function deleteCustodyDatabase(): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const request = indexedDB.deleteDatabase(CORE_CUSTODY_DB_NAME);
  request.onsuccess = () => {
    resolve(undefined);
  };
  request.onerror = request.onblocked = () => {
    reject(new Error('Custody database stayed open'));
  };
  return promise;
}

beforeEach(async () => {
  await deleteCustodyDatabase();
  await saveLocalWallet(ENTROPY);
});

afterEach(async () => {
  if (lease !== undefined) {
    await handleCoreCustody({ action: 'release', lease });
    lease = undefined;
  }
  await forgetLocalWallet();
});

describe('native Chat attachment sources in browser storage', () => {
  it('As a Chat core, I read back the exact attachment bytes I stored and nothing once I release them', async () => {
    // Given
    const token = await acquire();
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256);

    // When
    await handleCoreCustody({
      action: 'putSources',
      lease: token,
      sources: [{ sourceId: 'photo', blob: new Blob([bytes], { type: 'image/png' }) }],
    });

    // Then
    await expect(readSource(token, 'photo')).resolves.toEqual(bytes);
    await handleCoreCustody({ action: 'releaseSource', lease: token, sourceId: 'photo' });
    await expect(readSource(token, 'photo')).resolves.toBeUndefined();
  });

  it('As a Chat core, I read each of several sources stored together under its own id', async () => {
    // Given
    const token = await acquire();
    const first = new TextEncoder().encode('first attachment');
    const second = Uint8Array.from({ length: 4096 }, (_, i) => 255 - (i % 256));

    // When
    await handleCoreCustody({
      action: 'putSources',
      lease: token,
      sources: [
        { sourceId: 'first', blob: new Blob([first]) },
        { sourceId: 'second', blob: new Blob([second]) },
      ],
    });

    // Then
    await expect(readSource(token, 'second')).resolves.toEqual(second);
    await expect(readSource(token, 'first')).resolves.toEqual(first);
  });
});
