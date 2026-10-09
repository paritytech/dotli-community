// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockingModalCoordinator } from '../src/blocking-modal-queue.js';
import type * as PageCoreNamespace from '../src/page-core.js';

interface MockRuntime {
  activateLocalSession: ReturnType<typeof vi.fn>;
  notifySessionStoreChanged: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  runtimes: [] as MockRuntime[],
  createWebWorkerPairingHostRuntime: vi.fn(),
  HostWorker: vi.fn(),
  SigningWorker: vi.fn(),
  readWalletBoot: vi.fn(),
  reportLocalWalletFailure: vi.fn(),
  refreshLiteUsername: vi.fn(),
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
vi.mock('../src/host-callbacks/handlers.js', () => ({ createHostCallbacks: () => ({}) }));
vi.mock('../src/host-callbacks/SessionStore.js', () => ({ onStoredSessionChanged: () => () => {} }));
vi.mock('../../metrics/src/metrics.js', () => ({ m: { count: vi.fn() }, getResolutionId: vi.fn(() => null) }));

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const WALLET = {
  status: 'ok' as const,
  entropy: ENTROPY,
  identity: { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' },
};

function makeRuntime(): MockRuntime {
  const runtime = {
    activateLocalSession: vi.fn(() => Promise.resolve()),
    notifySessionStoreChanged: vi.fn(),
    dispose: vi.fn(),
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
  mocks.createWebWorkerPairingHostRuntime.mockImplementation(() => Promise.resolve(makeRuntime()));
  mocks.refreshLiteUsername.mockResolvedValue(undefined);
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
});
