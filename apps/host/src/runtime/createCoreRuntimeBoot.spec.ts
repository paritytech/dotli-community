// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import type {
  CreateWebWorkerPairingHostRuntimeOptions,
  WebWorkerHostCallbacks,
  WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { createBlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import { createCoreRuntimeBoot, type CoreRuntimeBootParams } from './createCoreRuntimeBoot.js';
import type { CoreCallbacksParams } from './hostCallbacks/createHostCallbacks.js';
import type { CoreContext } from './createPageCore.js';
import { createPhoneRequestTracker } from './createPhoneRequestTracker.js';
import type { BootLocalWalletCore } from './localWalletCore.js';
import type { LocalWalletBoot } from './createWalletBoot.js';
import { ERRORS } from './errors.js';
import { createDeferred } from '@dotli/shared';
import { catchRejection } from '@dotli/shared/testing';

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

const context: CoreContext = {
  product: { label: 'doom' },
  blockingModalScope: createBlockingModalCoordinator().createScope(),
  phoneRequests: createPhoneRequestTracker(),
  isLive: () => true,
  isInService: () => true,
  sessionInMemory: false,
};

class FakeHostWorker {
  readonly role = 'pairing';
}

/** A runtime whose only members the boot reads are its id parser, which takes an id as given, and its dispose. */
function createFakeRuntime() {
  const fake = {
    parseProductId: vi.fn((value: string) => Promise.resolve(asProductId(value))),
    dispose: vi.fn(),
  };
  // The fake has the members the boot calls, not the full runtime interface.
  return { ...fake, runtime: fake as unknown as WorkerPairingHostRuntime };
}

function createHarness({ reads = [] }: Params = {}) {
  // A copy, since each read but the last takes its answer off the front.
  const pending = [...reads];
  const pairing = createFakeRuntime();
  const local = createFakeRuntime();
  const create = vi.fn(
    (_worker: Worker, _callbacks: WebWorkerHostCallbacks, _options: CreateWebWorkerPairingHostRuntimeOptions) =>
      Promise.resolve(pairing.runtime),
  );
  const callbackOptions: CoreCallbacksParams[] = [];
  const bootLocalWalletCore = vi.fn<BootLocalWalletCore>(() => Promise.resolve(local.runtime));
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
    /** The runtime a pairing boot gets. */
    pairing,
    /** The runtime a local wallet boot gets. */
    local,
  };
}

describe('core runtime boot', () => {
  it('As a Polkadot App user, I boot the pairing host on the web worker and it keeps my paired session', async () => {
    // Given a boot with no stored wallet
    const { params, create, callbackOptions, bootLocalWalletCore, pairing } = createHarness({ reads: [null] });
    const boot = createCoreRuntimeBoot(params);

    // When a core boots
    const booted = await boot(context);

    // Then the pairing runtime boots on the host worker with a stored session
    expect(booted).toMatchObject({ runtime: pairing.runtime, local: false });
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(FakeHostWorker);
    expect(create.mock.calls[0]?.[2].role).toBeUndefined();
    expect(callbackOptions).toEqual([expect.objectContaining({ core: context, sessionInMemory: false })]);
    expect(bootLocalWalletCore).not.toHaveBeenCalled();
  });

  it('As a user in the sign-out window, I open it and it boots a pairing core whose session stays in memory', async () => {
    // Given a boot with no stored wallet
    const { params, callbackOptions, pairing } = createHarness({ reads: [null] });

    // When a core boots with its session in memory
    const booted = await createCoreRuntimeBoot(params)({ ...context, sessionInMemory: true });

    // Then a pairing core boots with the in-memory session option
    expect(booted).toMatchObject({ runtime: pairing.runtime, local: false });
    expect(callbackOptions).toEqual([expect.objectContaining({ sessionInMemory: true })]);
  });

  it('As a local wallet user, I boot a signing core and its storage leaves my paired session alone', async () => {
    // Given a boot over a stored wallet
    const { params, create, callbackOptions, bootLocalWalletCore, local } = createHarness({ reads: [WALLET] });
    const boot = createCoreRuntimeBoot(params);

    // When a core boots
    const booted = await boot(context);

    // Then the local wallet core boots with the wallet and an in-memory session
    expect(booted).toMatchObject({ runtime: local.runtime, local: true });
    const [localBoot] = bootLocalWalletCore.mock.calls[0] ?? [];
    expect(localBoot?.create).toBe(create);
    expect(localBoot?.hostConfig).not.toHaveProperty('productId');
    expect(localBoot?.wallet).toBe(WALLET);
    expect(localBoot?.isLive).toBe(context.isLive);
    expect(callbackOptions).toEqual([expect.objectContaining({ sessionInMemory: true })]);
    expect(callbackOptions[0]?.core).toBe(context);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { user: 'a local wallet user whose wallet read failed at boot', reads: [null, WALLET], local: false, stale: true },
    { user: 'a Polkadot App user with no local wallet', reads: [null], local: false, stale: false },
    { user: 'a local wallet user', reads: [WALLET], local: true, stale: false },
  ])('As $user, I ask whether my booted core is stale and it answers $stale', async ({ reads, local, stale }) => {
    // Given a booted core
    const { params } = createHarness({ reads });
    const booted = await createCoreRuntimeBoot(params)(context);

    // When the page asks whether it is stale
    const answer = await booted.isStale();

    // Then the core is local or pairing as booted, and answers as the row says
    expect(booted.local).toBe(local);
    expect(answer).toBe(stale);
  });

  it.each([
    { user: 'a Polkadot App user', read: null, runtime: 'pairing' },
    { user: 'a local wallet user', read: WALLET, runtime: 'local' },
  ] as const)(
    'As $user, I open a product and my core runs under the id it parsed, which my callbacks read',
    async ({ read, runtime }) => {
      // Given a core that parses the id it is asked for into its canonical form
      const fakes = createHarness({ reads: [read] });
      fakes[runtime].parseProductId.mockResolvedValue(asProductId('canonical.paseo'));

      // When a core boots for the product
      const booted = await createCoreRuntimeBoot(fakes.params)(context);

      // Then it parsed the label's id, and the result and the callbacks carry the parsed one
      expect(fakes[runtime].parseProductId).toHaveBeenCalledWith('doom.paseo');
      expect(booted.productId).toBe('canonical.paseo');
      expect(fakes.callbackOptions[0]?.getProductId()).toBe('canonical.paseo');
    },
  );

  it('As a developer, I open a local preview under an explicit product id and the core parses that id', async () => {
    // Given a boot with no stored wallet
    const { params, pairing } = createHarness({ reads: [null] });

    // When a core boots for a local preview with an explicit product id
    const booted = await createCoreRuntimeBoot(params)({
      ...context,
      product: { label: 'localhost:3000', productId: 'truapi-playground.dot' },
    });

    // Then the core parsed the explicit id, not the label's
    expect(pairing.parseProductId).toHaveBeenCalledWith('truapi-playground.dot');
    expect(booted.productId).toBe('truapi-playground.dot');
  });

  it('As a product, I call a callback before my core parsed my id and it throws', async () => {
    // Given a core whose id parse has not answered yet
    const { params, pairing, callbackOptions } = createHarness({ reads: [null] });
    const asked = createDeferred<undefined>();
    const parsed = createDeferred<ReturnType<typeof asProductId>>();
    pairing.parseProductId.mockImplementation(() => {
      asked.resolve(undefined);
      return parsed.promise;
    });
    const booting = createCoreRuntimeBoot(params)(context);
    await asked.promise;

    // When the callbacks read the id
    const read = (): unknown => callbackOptions[0]?.getProductId();

    // Then it is not ready yet, and once parsed it is
    expect(read).toThrow(ERRORS.PRODUCT_ID_NOT_READY);
    parsed.resolve(asProductId('doom.paseo'));
    await booting;
    expect(read()).toBe('doom.paseo');
  });

  it.each([
    { user: 'a Polkadot App user', read: null, runtime: 'pairing' },
    { user: 'a local wallet user', read: WALLET, runtime: 'local' },
  ] as const)(
    'As $user, I open a product whose id the core refuses and the boot fails with the runtime disposed',
    async ({ read, runtime }) => {
      // Given a core that refuses the id
      const fakes = createHarness({ reads: [read] });
      const refusal = new Error('invalid product ID');
      fakes[runtime].parseProductId.mockRejectedValue(refusal);

      // When a core boots for the product
      const error = await catchRejection(createCoreRuntimeBoot(fakes.params)(context));

      // Then the boot rejects with the refusal as its cause, and the runtime nobody holds is disposed
      expect(error).toMatchObject({ cause: refusal });
      expect(fakes[runtime].dispose).toHaveBeenCalledOnce();
    },
  );
});
