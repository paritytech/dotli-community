// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type {
  CreateWebWorkerPairingHostRuntimeOptions,
  WebWorkerHostCallbacks,
  WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { createBlockingModalCoordinator } from './blocking-modal-queue.js';
import { createCoreRuntimeBoot, type CoreRuntimeDeps } from './core-runtime.js';
import type { CreateHostCallbacksOptions } from './host-callbacks/handlers.js';
import { createPhoneRequestTracker } from './phone-requests.js';
import type { BootLocalWalletCore } from './local-wallet-core.js';
import { createSyncStore } from '@dotli/shared';
import type { WalletModeState } from './state/wallet-mode.js';
import { createWalletBoot, type LocalWalletBoot } from './wallet-boot.js';

const WALLET: LocalWalletBoot = {
  status: 'ok',
  entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  identity: null,
  version: Uint8Array.of(1),
};

class FakeHostWorker {
  readonly role = 'pairing';
}

const RUNTIME = {} as WorkerPairingHostRuntime;
const LOCAL_RUNTIME = {} as WorkerPairingHostRuntime;

interface Harness {
  deps: CoreRuntimeDeps;
  create: ReturnType<
    typeof vi.fn<
      (
        worker: Worker,
        callbacks: WebWorkerHostCallbacks,
        options: CreateWebWorkerPairingHostRuntimeOptions,
      ) => Promise<WorkerPairingHostRuntime>
    >
  >;
  callbackOptions: CreateHostCallbacksOptions[];
  bootLocalWalletCore: ReturnType<typeof vi.fn<BootLocalWalletCore>>;
}

function harness(...reads: (LocalWalletBoot | null)[]): Harness {
  const create = vi.fn(
    (_worker: Worker, _callbacks: WebWorkerHostCallbacks, _options: CreateWebWorkerPairingHostRuntimeOptions) =>
      Promise.resolve(RUNTIME),
  );
  const callbackOptions: CreateHostCallbacksOptions[] = [];
  const bootLocalWalletCore = vi.fn<BootLocalWalletCore>(() => Promise.resolve(LOCAL_RUNTIME));
  return {
    create,
    callbackOptions,
    bootLocalWalletCore,
    deps: {
      readWallet: () => Promise.resolve(reads.length > 1 ? (reads.shift() ?? null) : (reads[0] ?? null)),
      loadHostRuntime: () =>
        Promise.resolve({
          createWebWorkerPairingHostRuntime: create,
          HostWorker: FakeHostWorker as unknown as new () => Worker,
        }),
      createCallbacks: options => {
        callbackOptions.push(options);
        return {} as WebWorkerHostCallbacks;
      },
      loadLocalWalletCore: () => Promise.resolve({ bootLocalWalletCore }),
    },
  };
}

const request = {
  product: { label: 'doom' },
  blockingModalScope: createBlockingModalCoordinator().createScope(),
  phoneRequests: createPhoneRequestTracker(),
  isLive: () => true,
  inService: () => true,
};

describe('core runtime boot', () => {
  it('As a Polkadot App user, I boot the pairing host on the web worker and it keeps my paired session', async () => {
    // Given
    const { deps, create, callbackOptions, bootLocalWalletCore } = harness(null);
    const boot = createCoreRuntimeBoot(deps);

    // When
    const booted = await boot(request);

    // Then
    expect(booted).toMatchObject({ runtime: RUNTIME, local: false });
    const [worker, , options] = create.mock.calls[0] ?? [];
    expect(worker).toBeInstanceOf(FakeHostWorker);
    expect(options?.role).toBeUndefined();
    expect(callbackOptions).toEqual([expect.objectContaining({ label: 'doom', sessionInMemory: false })]);
    expect(bootLocalWalletCore).not.toHaveBeenCalled();
  });

  it("As a Polkadot App user, the callbacks get the page's in-service check", async () => {
    // Given
    const { deps, callbackOptions } = harness(null);
    const boot = createCoreRuntimeBoot(deps);

    // When
    await boot(request);

    // Then
    expect(callbackOptions[0]?.inService).toBe(request.inService);
  });

  it('As a user in the sign-out window, I open it and it boots a pairing core whose session stays in memory', async () => {
    // Given a boot with no stored wallet
    const { deps, callbackOptions } = harness(null);

    // When a core boots with its session in memory
    const booted = await createCoreRuntimeBoot(deps)({ ...request, sessionInMemory: true });

    // Then a pairing core boots with the in-memory session option
    expect(booted).toMatchObject({ runtime: RUNTIME, local: false });
    expect(callbackOptions).toEqual([expect.objectContaining({ sessionInMemory: true })]);
  });

  it('As a local wallet user, I boot a signing core whose storage leaves my paired session alone', async () => {
    // Given
    const { deps, create, callbackOptions, bootLocalWalletCore } = harness(WALLET);
    const boot = createCoreRuntimeBoot(deps);

    // When
    const booted = await boot(request);

    // Then
    expect(booted).toMatchObject({ runtime: LOCAL_RUNTIME, local: true });
    const [createRuntime, , hostConfig, wallet, isLive] = bootLocalWalletCore.mock.calls[0] ?? [];
    expect(createRuntime).toBe(create);
    expect(hostConfig).not.toHaveProperty('productId');
    expect(wallet).toBe(WALLET);
    expect(isLive).toBe(request.isLive);
    expect(callbackOptions).toEqual([expect.objectContaining({ sessionInMemory: true })]);
    expect(callbackOptions[0]?.inService).toBe(request.inService);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['As a Polkadot App user, my callbacks claim from the tracker my core was booted with', null],
    [
      'As a local wallet user, my callbacks get the tracker my core was booted with, which the page core disposes',
      WALLET,
    ],
  ] as [string, LocalWalletBoot | null][])('%s', async (_name, read) => {
    // Given
    const { deps, callbackOptions } = harness(read);

    // When
    await createCoreRuntimeBoot(deps)(request);

    // Then
    expect(callbackOptions[0]?.phoneRequests).toBe(request.phoneRequests);
  });

  it('As a user on the landing page, I pair under the name the page asked for', async () => {
    // Given
    const { deps, callbackOptions } = harness(null);
    const boot = createCoreRuntimeBoot(deps);

    // When
    await boot({
      ...request,
      product: { label: 'dotli', pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true } },
    });

    // Then
    expect(callbackOptions).toEqual([
      expect.objectContaining({
        label: 'dotli',
        pairingLabel: 'Polkadot Web',
        pairingDotSuffix: false,
        pairingHostGlobal: true,
        blockingModalScope: request.blockingModalScope,
      }),
    ]);
  });

  it('As a local wallet user whose wallet read failed at boot, my pairing core reads as stale once the wallet is found', async () => {
    // Given
    const { deps } = harness(null, WALLET);
    const booted = await createCoreRuntimeBoot(deps)(request);

    // When
    const stale = await booted.stale();

    // Then
    expect(booted.local).toBe(false);
    expect(stale).toBe(true);
  });

  it('As a Polkadot App user with no local wallet, my pairing core stays current', async () => {
    // Given
    const { deps } = harness(null);
    const booted = await createCoreRuntimeBoot(deps)(request);

    // When
    const stale = await booted.stale();

    // Then
    expect(stale).toBe(false);
  });

  it('As a local wallet user, my signing core stays current', async () => {
    // Given
    const { deps } = harness(WALLET);
    const booted = await createCoreRuntimeBoot(deps)(request);

    // When
    const stale = await booted.stale();

    // Then
    expect(stale).toBe(false);
  });

  it('As a user in the sign-in window, I open it over a stored wallet and it boots a pairing core', async () => {
    // Given the window's wallet boot over a stored local wallet
    const mode = createSyncStore<WalletModeState>('walletMode', { mode: 'app', failure: null });
    const walletBoot = createWalletBoot({
      reconcile: () =>
        Promise.resolve({
          presence: 'present',
          session: { status: 'ok', blob: null },
          wallet: WALLET,
          dead: null,
        }),
      report: mode.set,
      flag: { renew: () => undefined },
      role: 'signin-window',
    });
    const h = harness();

    // When a core boots
    const booted = await createCoreRuntimeBoot({ ...h.deps, readWallet: () => walletBoot.read() })(request);

    // Then the core pairs and the page stays out of local mode
    expect(booted.local).toBe(false);
    expect(h.bootLocalWalletCore).not.toHaveBeenCalled();
    expect(mode.get().mode).toBe('app');
  });
});
