// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BlockingModalCoordinator } from '../src/blocking-modal-queue.js';
import type { AuthState, CoreStorage, CoreStorageKey, RequiredHostCallbacks } from '@parity/truapi-host';
import type * as PageCoreNamespace from '../src/page-core.js';

interface MockRuntime {
  activateLocalSession: ReturnType<typeof vi.fn>;
  cancelPairing: ReturnType<typeof vi.fn>;
  notifySessionStoreChanged: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getPermissionAuthorizationStatuses: (productId: string, requests: unknown[]) => Promise<string[]>;
}

const mocks = vi.hoisted(() => ({
  runtimes: [] as MockRuntime[],
  createWebWorkerPairingHostRuntime: vi.fn(),
  HostWorker: vi.fn(),
  SigningWorker: vi.fn(),
  readWalletBoot: vi.fn(),
  reportLocalWalletFailure: vi.fn(),
  refreshLiteUsername: vi.fn(),
  createHostCallbacks: vi.fn(() => ({ auth: { authStateChanged: vi.fn() }, coreStorage: {} })),
  registerCoreStoragePermissionProvider: vi.fn(),
  unregisterRefresh: vi.fn(),
  waitForCoreStoragePermissionRefresh: vi.fn(),
  provider: { subscribeClose: vi.fn(), dispose: vi.fn() },
  createProvider: vi.fn(),
  chats: [] as {
    wallet: unknown;
    storage: object;
    nativeChatFiles: object;
    contacts: object;
    activated: Mock;
    dispose: Mock;
  }[],
}));

vi.mock('@parity/truapi-host/web', () => ({
  createWebWorkerPairingHostRuntime: mocks.createWebWorkerPairingHostRuntime,
}));
vi.mock('@parity/truapi-host/worker-runtime?worker', () => ({ default: mocks.HostWorker }));
vi.mock('../src/signing-worker.js?worker', () => ({ default: mocks.SigningWorker }));
vi.mock('../src/wallet-boot.js', () => ({
  readWalletBoot: mocks.readWalletBoot,
  reportLocalWalletFailure: mocks.reportLocalWalletFailure,
}));
vi.mock('../src/local-wallet-identity.js', () => ({ refreshLiteUsername: mocks.refreshLiteUsername }));
vi.mock('../src/host-callbacks/handlers.js', () => ({ createHostCallbacks: mocks.createHostCallbacks }));
vi.mock('../src/host-callbacks/SessionStore.js', () => ({
  onStoredSessionChanged: () => () => {},
  registerCoreStoragePermissionProvider: mocks.registerCoreStoragePermissionProvider,
  waitForCoreStoragePermissionRefresh: mocks.waitForCoreStoragePermissionRefresh,
}));
vi.mock('../../metrics/src/metrics.js', () => ({ m: { count: vi.fn() }, getResolutionId: vi.fn(() => null) }));
vi.mock('../src/local-wallet-chat.js', () => ({
  createLocalWalletChat: (wallet: unknown) => {
    const chat = {
      wallet,
      storage: { custody: true },
      nativeChatFiles: { files: true },
      contacts: { contacts: true },
      activated: vi.fn(),
      dispose: vi.fn(),
    };
    mocks.chats.push(chat);
    return {
      coreStorage: () => chat.storage,
      nativeChatFiles: chat.nativeChatFiles,
      openContacts: () => ({ callbacks: chat.contacts, dispose: vi.fn() }),
      authStateChanged: vi.fn(),
      activated: chat.activated,
      dispose: chat.dispose,
    };
  },
}));

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const WALLET = {
  status: 'ok' as const,
  entropy: ENTROPY,
  identity: { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' },
};

function makeRuntime(): MockRuntime {
  const runtime = {
    activateLocalSession: vi.fn(() => Promise.resolve()),
    cancelPairing: vi.fn(),
    notifySessionStoreChanged: vi.fn(),
    dispose: vi.fn(),
    getPermissionAuthorizationStatuses: () => Promise.resolve(['Denied']),
    createProvider: mocks.createProvider,
  };
  mocks.runtimes.push(runtime);
  return runtime;
}

const coordinator = {
  createScope: () => ({ dispose: vi.fn() }),
} as unknown as BlockingModalCoordinator;

async function loadPageCore(): Promise<typeof PageCoreNamespace> {
  const pageCore = await import('../src/page-core.js');
  pageCore.initPageCore(coordinator);
  return pageCore;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.runtimes.length = 0;
  mocks.chats.length = 0;
  mocks.createWebWorkerPairingHostRuntime.mockImplementation(() => Promise.resolve(makeRuntime()));
  mocks.refreshLiteUsername.mockResolvedValue(undefined);
  mocks.registerCoreStoragePermissionProvider.mockResolvedValue(mocks.unregisterRefresh);
  mocks.waitForCoreStoragePermissionRefresh.mockResolvedValue(undefined);
  mocks.createProvider.mockResolvedValue(mocks.provider);
});

describe('page core wallet mode', () => {
  it('As a Polkadot App user, I boot the pairing host on the web worker', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(null);
    const { acquireCore } = await loadPageCore();

    // When
    await acquireCore();

    // Then
    expect(mocks.HostWorker).toHaveBeenCalledTimes(1);
    expect(mocks.SigningWorker).not.toHaveBeenCalled();
    const options = mocks.createWebWorkerPairingHostRuntime.mock.calls[0]?.[2] as { role?: string };
    expect(options.role).toBeUndefined();
  });

  it('As a local wallet user, I boot a signing host and activate it with my cached name', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    const { acquireCore } = await loadPageCore();

    // When
    await acquireCore();

    // Then
    expect(mocks.SigningWorker).toHaveBeenCalledTimes(1);
    expect(mocks.HostWorker).not.toHaveBeenCalled();
    const options = mocks.createWebWorkerPairingHostRuntime.mock.calls[0]?.[2] as {
      role?: string;
      hostConfig: { networkSuffix?: string };
    };
    expect(options.role).toBe('signing');
    expect(options.hostConfig.networkSuffix).toBe('paseo');
    expect(mocks.runtimes[0]?.activateLocalSession).toHaveBeenCalledWith(ENTROPY, 'alice.42');
    expect(mocks.runtimes[0]?.notifySessionStoreChanged).not.toHaveBeenCalled();
  });

  it('As a local wallet user, I boot a core whose storage leaves my paired session alone', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    const { acquireCore } = await loadPageCore();

    // When
    await acquireCore();

    // Then
    expect(mocks.createHostCallbacks).toHaveBeenCalledWith(expect.objectContaining({ local: true }));
  });

  it('As a local wallet user, my native core remains authoritative for permission decisions', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    const { acquireCore } = await loadPageCore();

    // When
    await acquireCore();

    // Then
    await expect(
      mocks.runtimes[0]?.getPermissionAuthorizationStatuses('app.dot', [{ tag: 'IdentityDisclosure' }]),
    ).resolves.toEqual(['Denied']);
  });

  it('As a Media connection, I share core storage and refresh permissions until I close', async () => {
    mocks.readWalletBoot.mockResolvedValue(null);
    const { acquireCore } = await loadPageCore();
    const lease = await acquireCore();
    const media = {
      platform: {} as PageCoreNamespace.ConnectionMedia['platform'],
      authChanged: vi.fn(),
      observeStorage: vi.fn(),
    };
    const connection = await lease.connect('App', media);
    const callbacks = mocks.createProvider.mock.calls[0]?.[1] as RequiredHostCallbacks;
    const original = mocks.createHostCallbacks.mock.results[0]?.value as { coreStorage: CoreStorage };
    const registrationStorage = mocks.registerCoreStoragePermissionProvider.mock.calls[0]?.[0] as CoreStorage;
    expect(callbacks.media).toBe(media.platform);
    expect(callbacks.coreStorage).toBe(original.coreStorage);
    expect(callbacks.coreStorage).not.toBe(registrationStorage);
    expect(mocks.registerCoreStoragePermissionProvider).toHaveBeenCalledWith(
      registrationStorage, connection.productId, mocks.provider,
    );

    const state: AuthState = { tag: 'Disconnected' };
    callbacks.auth.authStateChanged(state);
    expect(media.authChanged).toHaveBeenCalledExactlyOnceWith(state);
    const request = { tag: 'Device', value: 'Camera' } as const;
    const key: CoreStorageKey = {
      tag: 'PermissionAuthorization',
      value: { productId: connection.productId, request },
    };
    registrationStorage.readCoreStorage = vi.fn().mockResolvedValue(undefined);
    await callbacks.coreStorage.readCoreStorage(key);
    expect(media.observeStorage).toHaveBeenCalledExactlyOnceWith(key);
    await connection.waitForPermissionRefresh(request);
    expect(mocks.waitForCoreStoragePermissionRefresh).toHaveBeenCalledWith(
      registrationStorage, connection.productId, request,
    );
    connection.close();
    connection.close();
    expect(mocks.unregisterRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.provider.dispose).toHaveBeenCalledTimes(1);
    callbacks.auth.authStateChanged(state);
    expect(media.authChanged).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('As a Polkadot App user, I boot a core that keeps my paired session', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(null);
    const { acquireCore } = await loadPageCore();

    // When
    await acquireCore();

    // Then
    expect(mocks.createHostCallbacks).toHaveBeenCalledWith(expect.objectContaining({ local: false }));
    expect(mocks.chats).toHaveLength(0);
  });

  it('As a local wallet user, my core holds native Chat custody and contacts until it is disposed', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    const { acquireCore } = await loadPageCore();

    // When
    const lease = await acquireCore();

    // Then
    const chat = mocks.chats[0];
    expect(chat?.wallet).toBe(WALLET);
    expect(mocks.createHostCallbacks).toHaveBeenCalledWith(
      expect.objectContaining({ local: true, contacts: chat?.contacts }),
    );
    const callbacks = mocks.createWebWorkerPairingHostRuntime.mock.calls[0]?.[1] as {
      coreStorage: unknown;
      nativeChatFiles: unknown;
    };
    expect(callbacks.coreStorage).toBe(chat?.storage);
    expect(callbacks.nativeChatFiles).toBe(chat?.nativeChatFiles);
    expect(chat?.activated).toHaveBeenCalledWith(mocks.runtimes[0]);

    // When
    lease.release();

    // Then
    expect(chat?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user whose username changed, I am activated again with the new name', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    mocks.refreshLiteUsername.mockResolvedValue('bob.7');
    const { acquireCore } = await loadPageCore();

    // When
    await acquireCore();

    // Then
    await vi.waitFor(() => {
      expect(mocks.runtimes[0]?.activateLocalSession).toHaveBeenLastCalledWith(ENTROPY, 'bob.7');
    });
    expect(mocks.runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(2);
  });

  it('As a local wallet user whose username is unchanged, I am activated once', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    const { acquireCore } = await loadPageCore();

    // When
    await acquireCore();

    // Then
    await vi.waitFor(() => {
      expect(mocks.refreshLiteUsername).toHaveBeenCalledTimes(1);
    });
    expect(mocks.runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user on a page with two cores, I get both re-activated by one username change', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    let changed!: (name: string) => void;
    mocks.refreshLiteUsername.mockReturnValue(
      new Promise<string>(resolve => {
        changed = resolve;
      }),
    );
    const { acquireCore, setPageProduct } = await loadPageCore();
    await acquireCore();
    setPageProduct({ label: 'other' });
    await acquireCore();

    // When
    changed('bob.7');

    // Then
    await vi.waitFor(() => {
      expect(mocks.runtimes[0]?.activateLocalSession).toHaveBeenLastCalledWith(ENTROPY, 'bob.7');
      expect(mocks.runtimes[1]?.activateLocalSession).toHaveBeenLastCalledWith(ENTROPY, 'bob.7');
    });
  });

  it('As a local wallet user whose activation fails, I see the core fail and the failure is reported', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    mocks.createWebWorkerPairingHostRuntime.mockImplementation(() => {
      const runtime = makeRuntime();
      runtime.activateLocalSession.mockRejectedValue(new Error('bad entropy'));
      return Promise.resolve(runtime);
    });
    const { acquireCore } = await loadPageCore();

    // When
    const lease = acquireCore();

    // Then
    await expect(lease).rejects.toThrow(/activation failed/);
    expect(mocks.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.reportLocalWalletFailure).toHaveBeenCalledWith(expect.any(Error), 'activate');
  });

  it('As a local wallet user, I close the login modal and my core never receives a pairing cancel', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(WALLET);
    const { setWalletModeState } = await import('../src/state/wallet-mode.js');
    setWalletModeState({ mode: 'local', failure: null });
    const { acquireCore, cancelPairing } = await loadPageCore();
    await acquireCore();

    // When
    cancelPairing();
    await Promise.resolve();

    // Then
    expect(mocks.runtimes[0]?.cancelPairing).not.toHaveBeenCalled();
  });

  it('As a Polkadot App user, I close the login modal and my core cancels the pairing', async () => {
    // Given
    mocks.readWalletBoot.mockResolvedValue(null);
    const { acquireCore, cancelPairing } = await loadPageCore();
    await acquireCore();

    // When
    cancelPairing();

    // Then
    await vi.waitFor(() => {
      expect(mocks.runtimes[0]?.cancelPairing).toHaveBeenCalledTimes(1);
    });
  });
});
