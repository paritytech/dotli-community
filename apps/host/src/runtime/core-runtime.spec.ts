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
import type { BootLocalWalletCore } from './local-wallet-core.js';
import type { LocalWalletBoot } from './wallet-boot.js';

const WALLET: LocalWalletBoot = {
  status: 'ok',
  entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  identity: null,
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
    expect(callbackOptions).toEqual([expect.objectContaining({ label: 'doom', local: false })]);
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
    expect(callbackOptions).toEqual([expect.objectContaining({ local: true })]);
    expect(callbackOptions[0]?.inService).toBe(request.inService);
    expect(create).not.toHaveBeenCalled();
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
});
