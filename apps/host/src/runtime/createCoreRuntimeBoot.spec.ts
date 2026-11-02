// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type {
  CreateWebWorkerPairingHostRuntimeOptions,
  WebWorkerHostCallbacks,
  WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { createBlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import { createCoreRuntimeBoot, type CoreRuntimeBootParams } from './createCoreRuntimeBoot.js';
import type { CoreCallbacksParams } from './hostCallbacks/createHostCallbacks.js';
import { createPhoneRequestTracker } from './createPhoneRequestTracker.js';
import type { BootLocalWalletCore } from './localWalletCore.js';
import { createSyncStore } from '@dotli/shared';
import type { WalletModeState } from './state/walletModeState.js';
import { createWalletBoot, type LocalWalletBoot } from './createWalletBoot.js';

type Params = {
  /** What each wallet read answers, in order, the last one repeating. None by default, which reads no wallet. */
  reads?: (LocalWalletBoot | null)[];
};

const WALLET: LocalWalletBoot = {
  status: 'ok',
  entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  identity: null,
  version: Uint8Array.of(1),
};

// Opaque stand-ins the boot only passes through, so no member of the runtime is ever read.
const RUNTIME = {} as WorkerPairingHostRuntime;
const LOCAL_RUNTIME = {} as WorkerPairingHostRuntime;

const request = {
  product: { label: 'doom' },
  blockingModalScope: createBlockingModalCoordinator().createScope(),
  phoneRequests: createPhoneRequestTracker(),
  isLive: () => true,
  isInService: () => true,
};

class FakeHostWorker {
  readonly role = 'pairing';
}

function createHarness({ reads = [] }: Params = {}) {
  // A copy, since each read but the last takes its answer off the front.
  const pending = [...reads];
  const create = vi.fn(
    (_worker: Worker, _callbacks: WebWorkerHostCallbacks, _options: CreateWebWorkerPairingHostRuntimeOptions) =>
      Promise.resolve(RUNTIME),
  );
  const callbackOptions: CoreCallbacksParams[] = [];
  const bootLocalWalletCore = vi.fn<BootLocalWalletCore>(() => Promise.resolve(LOCAL_RUNTIME));
  const params: CoreRuntimeBootParams = {
    readWallet: () => Promise.resolve(pending.length > 1 ? (pending.shift() ?? null) : (pending[0] ?? null)),
    loadHostRuntime: () =>
      Promise.resolve({
        createWebWorkerPairingHostRuntime: create,
        // The boot only constructs the worker and hands it to `create`, so a class with no worker members stands in.
        HostWorker: FakeHostWorker as unknown as new () => Worker,
      }),
    createCallbacks(options) {
      callbackOptions.push(options);
      // An opaque stand-in the boot only passes through to the runtime factory.
      return {} as WebWorkerHostCallbacks;
    },
    loadLocalWalletCore: () => Promise.resolve({ bootLocalWalletCore }),
  };
  return {
    /** The boot's params over the fakes, with the wallet reads given in order, the last one repeating. */
    params,
    /** The pairing runtime factory. */
    create,
    /** The params of every callbacks object the boot asked for. */
    callbackOptions,
    /** The local wallet core's boot. */
    bootLocalWalletCore,
  };
}

describe('core runtime boot', () => {
  it('As a Polkadot App user, I boot the pairing host on the web worker and it keeps my paired session', async () => {
    // Given a boot with no stored wallet
    const { params, create, callbackOptions, bootLocalWalletCore } = createHarness({ reads: [null] });
    const boot = createCoreRuntimeBoot(params);

    // When a core boots
    const booted = await boot(request);

    // Then the pairing runtime boots on the host worker with a stored session
    expect(booted).toMatchObject({ runtime: RUNTIME, local: false });
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(FakeHostWorker);
    expect(create.mock.calls[0]?.[2].role).toBeUndefined();
    expect(callbackOptions).toEqual([expect.objectContaining({ label: 'doom', sessionInMemory: false })]);
    expect(bootLocalWalletCore).not.toHaveBeenCalled();
  });

  it("As a Polkadot App user, I boot my core and its callbacks get the page's in-service check", async () => {
    // Given a boot with no stored wallet
    const { params, callbackOptions } = createHarness({ reads: [null] });
    const boot = createCoreRuntimeBoot(params);

    // When a core boots
    await boot(request);

    // Then the callbacks hold the page's check
    expect(callbackOptions[0]?.isInService).toBe(request.isInService);
  });

  it('As a user in the sign-out window, I open it and it boots a pairing core whose session stays in memory', async () => {
    // Given a boot with no stored wallet
    const { params, callbackOptions } = createHarness({ reads: [null] });

    // When a core boots with its session in memory
    const booted = await createCoreRuntimeBoot(params)({ ...request, sessionInMemory: true });

    // Then a pairing core boots with the in-memory session option
    expect(booted).toMatchObject({ runtime: RUNTIME, local: false });
    expect(callbackOptions).toEqual([expect.objectContaining({ sessionInMemory: true })]);
  });

  it('As a local wallet user, I boot a signing core and its storage leaves my paired session alone', async () => {
    // Given a boot over a stored wallet
    const { params, create, callbackOptions, bootLocalWalletCore } = createHarness({ reads: [WALLET] });
    const boot = createCoreRuntimeBoot(params);

    // When a core boots
    const booted = await boot(request);

    // Then the local wallet core boots with the wallet and an in-memory session
    expect(booted).toMatchObject({ runtime: LOCAL_RUNTIME, local: true });
    const [localBoot] = bootLocalWalletCore.mock.calls[0] ?? [];
    expect(localBoot?.create).toBe(create);
    expect(localBoot?.hostConfig).not.toHaveProperty('productId');
    expect(localBoot?.wallet).toBe(WALLET);
    expect(localBoot?.isLive).toBe(request.isLive);
    expect(callbackOptions).toEqual([expect.objectContaining({ sessionInMemory: true })]);
    expect(callbackOptions[0]?.isInService).toBe(request.isInService);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { user: 'a Polkadot App user', read: null },
    { user: 'a local wallet user', read: WALLET },
  ])('As $user, I boot my core and its callbacks claim from the tracker it was booted with', async ({ read }) => {
    // Given a boot over the wallet read
    const { params, callbackOptions } = createHarness({ reads: [read] });

    // When a core boots
    await createCoreRuntimeBoot(params)(request);

    // Then the callbacks hold the tracker the boot was given
    expect(callbackOptions[0]?.phoneRequests).toBe(request.phoneRequests);
  });

  it('As a user on the landing page, I pair and the core uses the name the page asked for', async () => {
    // Given a boot with no stored wallet
    const { params, callbackOptions } = createHarness({ reads: [null] });
    const boot = createCoreRuntimeBoot(params);

    // When a core boots for the landing page's pairing name
    await boot({
      ...request,
      product: { label: 'dotli', pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true } },
    });

    // Then the callbacks carry the pairing name
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

  it.each([
    { user: 'a local wallet user whose wallet read failed at boot', reads: [null, WALLET], local: false, stale: true },
    { user: 'a Polkadot App user with no local wallet', reads: [null], local: false, stale: false },
    { user: 'a local wallet user', reads: [WALLET], local: true, stale: false },
  ])('As $user, I ask whether my booted core is stale and it answers $stale', async ({ reads, local, stale }) => {
    // Given a booted core
    const { params } = createHarness({ reads });
    const booted = await createCoreRuntimeBoot(params)(request);

    // When the page asks whether it is stale
    const answer = await booted.isStale();

    // Then the core is local or pairing as booted, and answers as the row says
    expect(booted.local).toBe(local);
    expect(answer).toBe(stale);
  });

  it('As a user in the sign-in window, I open it over a stored wallet and it boots a pairing core', async () => {
    // Given the window's wallet boot over a stored local wallet
    const mode = createSyncStore<WalletModeState>({ name: 'walletMode', initial: { mode: 'app', failure: null } });
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
    const fakes = createHarness();

    // When a core boots
    const booted = await createCoreRuntimeBoot({ ...fakes.params, readWallet: () => walletBoot.read() })(request);

    // Then the core pairs and the page stays out of local mode
    expect(booted.local).toBe(false);
    expect(fakes.bootLocalWalletCore).not.toHaveBeenCalled();
    expect(mode.get().mode).toBe('app');
  });
});
