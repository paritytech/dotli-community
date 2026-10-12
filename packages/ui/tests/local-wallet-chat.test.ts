// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreCustodyOperation } from '@dotli/protocol';
import type { CoreStorage, CoreStorageKey } from '@parity/truapi-host';
import { createLocalWalletChat } from '../src/local-wallet-chat.js';
import type { LocalWalletBoot } from '../src/wallet-boot.js';

const custody = vi.hoisted(() => ({
  operations: [] as CoreCustodyOperation[],
  acquisition: Promise.resolve<string>('lease-1'),
  records: new Map<string, Uint8Array>(),
}));

vi.mock('../../protocol/src/client.js', () => ({
  requestCoreCustody: (_siteId: string, operation: CoreCustodyOperation) => {
    custody.operations.push(operation);
    switch (operation.action) {
      case 'acquire':
        return custody.acquisition;
      case 'write':
        custody.records.set(operation.key, operation.value);
        return Promise.resolve(undefined);
      case 'read':
        return Promise.resolve(custody.records.get(operation.key));
      case 'compareExchange': {
        const current = custody.records.get(operation.key) ?? null;
        const matches =
          current === null || operation.expected === null
            ? current === operation.expected
            : current.join() === operation.expected.join();
        if (matches) {
          custody.records.set(operation.key, operation.replacement);
        }
        return Promise.resolve(matches);
      }
      case 'clear':
      case 'release':
      case 'putSources':
      case 'readSource':
      case 'releaseSource':
        return Promise.resolve(undefined);
    }
  },
}));

vi.mock('@parity/truapi-host/web', () => ({
  createBrowserNativeChatFilesHost: () => ({ dispose: vi.fn() }),
}));

const WALLET: LocalWalletBoot = { status: 'ok', entropy: new Uint8Array(16).fill(1), identity: null };
const PURSE = {
  tag: 'MainPurseCoinage',
  value: { rootPublicKey: new Uint8Array(32).fill(7), genesisHash: new Uint8Array(32).fill(8) },
} satisfies CoreStorageKey;
const GRANT = { tag: 'PairingDeviceIdentity' } satisfies CoreStorageKey;

function memoryStorage(): CoreStorage & { values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    readCoreStorage: key => Promise.resolve(values.get(key.tag)),
    writeCoreStorage: (key, value) => {
      values.set(key.tag, value);
      return Promise.resolve();
    },
    clearCoreStorage: key => {
      values.delete(key.tag);
      return Promise.resolve();
    },
    compareExchangeCoreStorage: (key, expected, replacement) => {
      const current = values.get(key.tag);
      const matches =
        current === undefined || expected === undefined ? current === expected : current.join() === expected.join();
      if (matches) {
        values.set(key.tag, replacement);
      }
      return Promise.resolve(matches);
    },
    coreStorageChanged: () => undefined,
  };
}

beforeEach(() => {
  custody.operations.length = 0;
  custody.records.clear();
  custody.acquisition = Promise.resolve('lease-1');
});

describe('native Chat beside the local wallet core', () => {
  it('As a local wallet core, Chat records go to custody under my wallet while other slots stay in host storage', async () => {
    // Given
    const chat = createLocalWalletChat(WALLET, () => true);
    const base = memoryStorage();
    const storage = chat.coreStorage(base);

    // When
    await storage.writeCoreStorage(PURSE, new Uint8Array([1, 2, 3]));
    await storage.writeCoreStorage(GRANT, new Uint8Array([4]));

    // Then
    expect(await storage.readCoreStorage(PURSE)).toEqual(new Uint8Array([1, 2, 3]));
    expect(base.values.has('MainPurseCoinage')).toBe(false);
    expect(base.values.get('PairingDeviceIdentity')).toEqual(new Uint8Array([4]));
    const acquire = custody.operations.find(operation => operation.action === 'acquire');
    expect(acquire).toMatchObject({ action: 'acquire', wallet: expect.stringMatching(/^[0-9a-f]{64}$/) as string });
    expect(custody.operations.filter(operation => operation.action === 'write')).toEqual([
      expect.objectContaining({ lease: 'lease-1' }),
    ]);
    chat.dispose();
  });

  it('As a local wallet core, compare-exchange of a Chat record goes to custody and other slots to host storage', async () => {
    // Given
    const chat = createLocalWalletChat(WALLET, () => true);
    const base = memoryStorage();
    const storage = chat.coreStorage(base);

    // When
    const created = await storage.compareExchangeCoreStorage(PURSE, undefined, new Uint8Array([1]), false);
    const stale = await storage.compareExchangeCoreStorage(PURSE, new Uint8Array([2]), new Uint8Array([3]), false);
    const replaced = await storage.compareExchangeCoreStorage(PURSE, new Uint8Array([1]), new Uint8Array([4]), false);
    const granted = await storage.compareExchangeCoreStorage(GRANT, undefined, new Uint8Array([5]), true);

    // Then
    expect([created, stale, replaced, granted]).toEqual([true, false, true, true]);
    expect(await storage.readCoreStorage(PURSE)).toEqual(new Uint8Array([4]));
    expect(base.values.has('MainPurseCoinage')).toBe(false);
    expect(base.values.get('PairingDeviceIdentity')).toEqual(new Uint8Array([5]));
    expect(custody.operations.filter(operation => operation.action === 'compareExchange')).toHaveLength(3);
    chat.dispose();
  });

  it('As a core disposed while custody is still being acquired, I release the late lease and refuse new Chat writes', async () => {
    // Given
    const { promise, resolve } = Promise.withResolvers<string>();
    custody.acquisition = promise;
    const chat = createLocalWalletChat(WALLET, () => true);
    const storage = chat.coreStorage(memoryStorage());

    // When
    chat.dispose();
    resolve('late-lease');

    // Then
    await vi.waitFor(() => {
      expect(custody.operations).toContainEqual({ action: 'release', lease: 'late-lease' });
    });
    await expect(storage.writeCoreStorage(PURSE, new Uint8Array([9]))).rejects.toThrow(
      'Native Chat custody was released',
    );
  });

  it('As a second tab refused custody, my Chat records fail while other slots keep working', async () => {
    // Given
    const busy = new Error('Chat is open with this local wallet in another tab. Close it there to use Chat here.');
    busy.name = 'CoreCustodyBusyError';
    const refused = Promise.reject(busy);
    // The core observes it only after hashing the wallet, a task later.
    refused.catch(() => undefined);
    custody.acquisition = refused;
    const chat = createLocalWalletChat(WALLET, () => true);
    const storage = chat.coreStorage(memoryStorage());

    // Then
    await expect(storage.readCoreStorage(PURSE)).rejects.toThrow('another tab');
    await storage.writeCoreStorage(GRANT, new Uint8Array([1]));
    expect(await storage.readCoreStorage(GRANT)).toEqual(new Uint8Array([1]));
    chat.dispose();
    expect(custody.operations.some(operation => operation.action === 'release')).toBe(false);
  });
});
