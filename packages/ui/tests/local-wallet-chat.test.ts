// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreCustodyOperation } from '@dotli/protocol';
import type { CoreStorage, CoreStorageKey } from '@parity/truapi-host';
import * as config from '@dotli/config';
import { encodeCoreStorageKey } from '@parity/truapi-host';
import { bytesToHex } from '@parity/truapi/scale';
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
      case 'clear':
        custody.records.delete(operation.key);
        return Promise.resolve(undefined);
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
const CHAT_ACCESS = {
  tag: 'PermissionAuthorization',
  value: { productId: 'echat.paseo', request: { tag: 'ChatAuthority' } },
} satisfies CoreStorageKey;
const PROFILE_KEYS = [
  { tag: 'ProfileDisclosure', value: PURSE.value },
  { tag: 'ProfileReferencesReceived', value: { ...PURSE.value, productId: 'echat.paseo' } },
  { tag: 'ProfilePersonalReferencesReceived', value: PURSE.value },
] satisfies CoreStorageKey[];

function memoryKey(key: CoreStorageKey): string {
  return bytesToHex(encodeCoreStorageKey(key));
}

function memoryStorage(): CoreStorage & { values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    readCoreStorage: key => Promise.resolve(values.get(memoryKey(key))),
    writeCoreStorage: (key, value) => {
      values.set(memoryKey(key), value);
      return Promise.resolve();
    },
    clearCoreStorage: key => {
      values.delete(memoryKey(key));
      return Promise.resolve();
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
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
    expect(base.values.has(memoryKey(PURSE))).toBe(false);
    expect(base.values.get(memoryKey(GRANT))).toEqual(new Uint8Array([4]));
    const acquire = custody.operations.find(operation => operation.action === 'acquire');
    expect(acquire).toMatchObject({ action: 'acquire', wallet: expect.stringMatching(/^[0-9a-f]{64}$/) as string });
    expect(custody.operations.filter(operation => operation.action === 'write')).toEqual([
      expect.objectContaining({ lease: 'lease-1' }),
    ]);
    chat.dispose();
  });

  it('As a local wallet, Chat access I granted one Chat app is visible to every product page, and only to this wallet', async () => {
    // Given
    const chatAccess = {
      tag: 'PermissionAuthorization',
      value: { productId: 'echat.paseo', request: { tag: 'ChatAuthority' } },
    } satisfies CoreStorageKey;
    const otherGrant = {
      tag: 'PermissionAuthorization',
      value: { productId: 'echat.paseo', request: { tag: 'IdentityDisclosure' } },
    } satisfies CoreStorageKey;
    const chatPage = createLocalWalletChat(WALLET, () => true);
    const chatPageBase = memoryStorage();

    // When
    await chatPage.coreStorage(chatPageBase).writeCoreStorage(chatAccess, new Uint8Array([2]));
    await chatPage.coreStorage(chatPageBase).writeCoreStorage(otherGrant, new Uint8Array([2]));
    chatPage.dispose();
    const otherPage = createLocalWalletChat(WALLET, () => true);
    const otherWallet = createLocalWalletChat({ ...WALLET, entropy: new Uint8Array(16).fill(2) }, () => true);

    // Then
    expect(chatPageBase.values.has(memoryKey(otherGrant))).toBe(true);
    expect(custody.records.size).toBe(1);
    expect(await otherPage.coreStorage(memoryStorage()).readCoreStorage(chatAccess)).toEqual(new Uint8Array([2]));
    expect(await otherWallet.coreStorage(memoryStorage()).readCoreStorage(chatAccess)).toBeUndefined();
    otherPage.dispose();
    otherWallet.dispose();
  });

  it('As a local wallet, the host channel keys my contacts sent on the Chat page are there on every product page', async () => {
    // Given
    const peers = {
      tag: 'HostChannelPeers',
      value: { rootPublicKey: new Uint8Array(32).fill(3), genesisHash: new Uint8Array(32).fill(4) },
    } satisfies CoreStorageKey;
    const chatPage = createLocalWalletChat(WALLET, () => true);
    const chatPageBase = memoryStorage();

    // When
    await chatPage.coreStorage(chatPageBase).writeCoreStorage(peers, new Uint8Array([5]));
    chatPage.dispose();
    const seityPage = createLocalWalletChat(WALLET, () => true);

    // Then
    expect(chatPageBase.values.has(memoryKey(peers))).toBe(false);
    expect(await seityPage.coreStorage(memoryStorage()).readCoreStorage(peers)).toEqual(new Uint8Array([5]));
    seityPage.dispose();
  });

  it('As a local wallet, the profile I share on one product page is what my Chat app page relays', async () => {
    // Given
    const disclosure = {
      tag: 'ProfileDisclosure',
      value: { rootPublicKey: new Uint8Array(32).fill(3), genesisHash: new Uint8Array(32).fill(4) },
    } satisfies CoreStorageKey;
    const seityPage = createLocalWalletChat(WALLET, () => true);
    const seityPageBase = memoryStorage();

    // When
    await seityPage.coreStorage(seityPageBase).writeCoreStorage(disclosure, new Uint8Array([6]));
    seityPage.dispose();
    const chatPage = createLocalWalletChat(WALLET, () => true);

    // Then
    expect(seityPageBase.values.has(memoryKey(disclosure))).toBe(false);
    expect(await chatPage.coreStorage(memoryStorage()).readCoreStorage(disclosure)).toEqual(new Uint8Array([6]));
    chatPage.dispose();
  });

  it.each(PROFILE_KEYS)('migrates existing $tag bytes once and shares them across product pages', async key => {
    const legacy = memoryStorage();
    const bytes = new Uint8Array([7, 8, 9]);
    await legacy.writeCoreStorage(key, bytes);
    const firstPage = createLocalWalletChat(WALLET, () => true);
    expect(await firstPage.coreStorage(legacy).readCoreStorage(key)).toEqual(bytes);
    expect(await legacy.readCoreStorage(key)).toBeUndefined();
    firstPage.dispose();

    const otherPage = createLocalWalletChat(WALLET, () => true);
    expect(await otherPage.coreStorage(memoryStorage()).readCoreStorage(key)).toEqual(bytes);
    otherPage.dispose();
  });

  it.each(PROFILE_KEYS)('never overwrites newer $tag custody or resurrects a cleared record', async key => {
    const chat = createLocalWalletChat(WALLET, () => true);
    const newer = chat.coreStorage(memoryStorage());
    await newer.writeCoreStorage(key, new Uint8Array([9]));
    const stale = memoryStorage();
    await stale.writeCoreStorage(key, new Uint8Array([1]));
    expect(await chat.coreStorage(stale).readCoreStorage(key)).toEqual(new Uint8Array([9]));

    await newer.clearCoreStorage(key);
    const anotherOrigin = memoryStorage();
    await anotherOrigin.writeCoreStorage(key, new Uint8Array([2]));
    expect(await chat.coreStorage(anotherOrigin).readCoreStorage(key)).toBeUndefined();
    expect(await anotherOrigin.readCoreStorage(key)).toBeUndefined();
    chat.dispose();
  });

  it('keeps a failed migration recoverable without deleting the legacy bytes', async () => {
    const key = PROFILE_KEYS[0]!;
    const legacy = memoryStorage();
    await legacy.writeCoreStorage(key, new Uint8Array([3]));
    const originalRead = legacy.readCoreStorage;
    legacy.readCoreStorage = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockImplementation(originalRead);
    const chat = createLocalWalletChat(WALLET, () => true);
    const storage = chat.coreStorage(legacy);
    await expect(storage.readCoreStorage(key)).rejects.toThrow('storage unavailable');
    expect(await storage.readCoreStorage(key)).toEqual(new Uint8Array([3]));
    chat.dispose();
  });

  it('serializes a delayed upgrade read before a newer write on the same slot', async () => {
    const key = PROFILE_KEYS[0]!;
    const legacy = memoryStorage();
    const started = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<Uint8Array>();
    legacy.readCoreStorage = () => {
      started.resolve();
      return delayed.promise;
    };
    const chat = createLocalWalletChat(WALLET, () => true);
    const storage = chat.coreStorage(legacy);
    const reading = storage.readCoreStorage(key);
    await started.promise;
    const writing = storage.writeCoreStorage(key, new Uint8Array([9]));
    delayed.resolve(new Uint8Array([1]));
    expect(await reading).toEqual(new Uint8Array([1]));
    await writing;
    expect(await storage.readCoreStorage(key)).toEqual(new Uint8Array([9]));
    chat.dispose();
  });

  it('preserves ambiguous legacy Chat grants but requires fresh consent under wallet and network scope', async () => {
    const legacy = memoryStorage();
    const oldGrant = new Uint8Array([1]);
    await legacy.writeCoreStorage(CHAT_ACCESS, oldGrant);
    const chat = createLocalWalletChat(WALLET, () => true);
    const storage = chat.coreStorage(legacy);
    expect(await storage.readCoreStorage(CHAT_ACCESS)).toBeUndefined();
    expect(await legacy.readCoreStorage(CHAT_ACCESS)).toEqual(oldGrant);
    await storage.writeCoreStorage(CHAT_ACCESS, new Uint8Array([2]));
    chat.dispose();

    const otherWallet = createLocalWalletChat({ ...WALLET, entropy: new Uint8Array(16).fill(2) }, () => true);
    expect(await otherWallet.coreStorage(legacy).readCoreStorage(CHAT_ACCESS)).toBeUndefined();
    otherWallet.dispose();

    const current = config.getActiveServicesConfig();
    vi.spyOn(config, 'getActiveServicesConfig').mockReturnValue({
      ...current,
      people: { ...current.people, genesis: `0x${'ab'.repeat(32)}` },
    });
    const otherNetwork = createLocalWalletChat(WALLET, () => true);
    expect(await otherNetwork.coreStorage(legacy).readCoreStorage(CHAT_ACCESS)).toBeUndefined();
    expect(await legacy.readCoreStorage(CHAT_ACCESS)).toEqual(oldGrant);
    otherNetwork.dispose();
  });

  it.each(PROFILE_KEYS)('keeps migrated $tag scoped to its root and network', async key => {
    const legacy = memoryStorage();
    await legacy.writeCoreStorage(key, new Uint8Array([4]));
    const chat = createLocalWalletChat(WALLET, () => true);
    const storage = chat.coreStorage(legacy);
    expect(await storage.readCoreStorage(key)).toEqual(new Uint8Array([4]));
    expect(await storage.readCoreStorage({
      ...key, value: { ...key.value, rootPublicKey: new Uint8Array(32).fill(6) },
    })).toBeUndefined();
    expect(await storage.readCoreStorage({
      ...key, value: { ...key.value, genesisHash: new Uint8Array(32).fill(6) },
    })).toBeUndefined();
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
