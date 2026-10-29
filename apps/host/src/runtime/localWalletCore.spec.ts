// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AuthState } from '@parity/truapi-host';
import type {
  CreateWebWorkerPairingHostRuntimeOptions,
  WebWorkerHostCallbacks,
  WebWorkerHostConfig,
  WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { createLocalWalletCoreBoot, type LocalWalletCoreBootParams } from './localWalletCore.js';
import { createChanges, type Changes } from '../testing/changes.js';
import { createRecordingCallbacks } from '../testing/createRecordingCallbacks.js';
import type { LocalWalletBoot } from './createWalletBoot.js';

type FakeRuntime = ReturnType<typeof createFakeRuntime>;

type CreateFakeRuntimeParams = {
  /** How the runtime's activation settles, at once by default. */
  activate?: (() => Promise<void>) | undefined;
};

type CreateFakeRuntimeFactoryParams = {
  /** Every runtime the factory built, in order. */
  runtimes?: FakeRuntime[];
  /** How each runtime's activation settles, at once by default. */
  activate?: () => Promise<void>;
  /** An auth state each runtime reports through its callbacks as it is built. */
  reports?: AuthState;
};

type BuildBootParamsParams = {
  create: ReturnType<typeof createFakeRuntimeFactory>;
  /** Where the callbacks record each auth state, none by default. */
  states?: AuthState[];
  /** Whether the core is still live, true by default. */
  isLive?: boolean;
};

const PUBLIC_KEY = `0x${'01'.repeat(32)}` as const;
const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}` as const;

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const WALLET: LocalWalletBoot = {
  status: 'ok',
  entropy: ENTROPY,
  identity: { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' },
  version: Uint8Array.of(1),
};
// The boot only spreads the config into the signing host's, so a partial one stands in.
const HOST_CONFIG = { host: { name: 'Polkadot Web' } } as WebWorkerHostConfig;

class FakeSigningWorker {
  readonly role = 'signing';
}

function createFakeRuntime({ activate = () => Promise.resolve() }: CreateFakeRuntimeParams = {}) {
  return {
    activateLocalSession: vi.fn<(secret: Uint8Array, name?: string) => Promise<void>>(activate),
    dispose: vi.fn<() => void>(),
  };
}

/** A signing host maker that records what it was asked to build. */
function createFakeRuntimeFactory({ runtimes = [], activate, reports }: CreateFakeRuntimeFactoryParams = {}) {
  return vi.fn(
    (_worker: Worker, callbacks: WebWorkerHostCallbacks, _options: CreateWebWorkerPairingHostRuntimeOptions) => {
      if (reports !== undefined) {
        callbacks.auth.authStateChanged(reports);
      }
      const runtime = createFakeRuntime({ activate });
      runtimes.push(runtime);
      // The fake has the two members the boot calls, not the full runtime interface.
      return Promise.resolve(runtime as unknown as WorkerPairingHostRuntime);
    },
  );
}

/** An activation that succeeds and tells `changes`, so a test waits for a later one rather than polling. */
function createAnnouncedActivation(changes: Changes): () => Promise<void> {
  function activate(): Promise<void> {
    changes.notify();
    return Promise.resolve();
  }
  return activate;
}

function buildParams(overrides: Partial<LocalWalletCoreBootParams> = {}): LocalWalletCoreBootParams {
  return {
    // The boot only constructs the worker and hands it to the runtime factory, so a class with no worker members fits.
    loadSigningWorker: () => Promise.resolve({ default: FakeSigningWorker as unknown as new () => Worker }),
    refreshLiteUsername: () => Promise.resolve(undefined),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

/** One core to boot over `create`, with the test wallet and host config. */
function buildBootParams({ create, states = [], isLive = true }: BuildBootParamsParams) {
  return {
    create,
    callbacks: createRecordingCallbacks(states),
    hostConfig: HOST_CONFIG,
    wallet: WALLET,
    isLive: () => isLive,
  };
}

describe('local wallet core', () => {
  it('As a local wallet user, I boot a signing host and activate it with my cached name', async () => {
    // Given a boot over a fake signing host maker
    const runtimes: FakeRuntime[] = [];
    const create = createFakeRuntimeFactory({ runtimes });
    const boot = createLocalWalletCoreBoot(buildParams());

    // When the core boots
    await boot(buildBootParams({ create }));

    // Then the signing host is built on the signing worker and activated with the cached name
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(FakeSigningWorker);
    expect(create.mock.calls[0]?.[2].role).toBe('signing');
    expect(create.mock.calls[0]?.[2].hostConfig.networkSuffix).toBe('paseo');
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledWith(ENTROPY, 'alice.42');
  });

  it('As a local wallet user, I boot my core and my username is read for the identity account it reports', async () => {
    // Given a core that reports a connected identity account as it is built
    const states: AuthState[] = [];
    const connected: AuthState = {
      tag: 'Connected',
      value: { publicKey: PUBLIC_KEY, identityAccountId: IDENTITY_ACCOUNT },
    };
    const refreshLiteUsername = vi.fn<LocalWalletCoreBootParams['refreshLiteUsername']>(() =>
      Promise.resolve(undefined),
    );
    const boot = createLocalWalletCoreBoot(buildParams({ refreshLiteUsername }));

    // When the core boots
    await boot(buildBootParams({ create: createFakeRuntimeFactory({ reports: connected }), states }));

    // Then the name is read for the wallet and the reported account, and the state passes on
    expect(refreshLiteUsername.mock.calls[0]?.[0]).toBe(WALLET);
    await expect(refreshLiteUsername.mock.calls[0]?.[1]).resolves.toBe(IDENTITY_ACCOUNT);
    expect(states).toEqual([connected]);
  });

  it('As a local wallet user whose username changed, I boot my core and am activated again with the new name', async () => {
    // Given a network that holds a new name
    const runtimes: FakeRuntime[] = [];
    const changes = createChanges();
    const boot = createLocalWalletCoreBoot(buildParams({ refreshLiteUsername: () => Promise.resolve('bob.7') }));

    // When the core boots and the new name arrives
    await boot(
      buildBootParams({ create: createFakeRuntimeFactory({ runtimes, activate: createAnnouncedActivation(changes) }) }),
    );
    await changes.until(() => runtimes[0]?.activateLocalSession.mock.lastCall?.[1] === 'bob.7');

    // Then the core is activated twice, the last time with the new name
    expect(runtimes[0]?.activateLocalSession).toHaveBeenLastCalledWith(ENTROPY, 'bob.7');
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(2);
  });

  it('As a local wallet user whose username is unchanged, I boot my core and am activated once', async () => {
    // Given a network that holds the cached name
    const runtimes: FakeRuntime[] = [];
    const unchanged = Promise.resolve(undefined);
    const boot = createLocalWalletCoreBoot(buildParams({ refreshLiteUsername: () => unchanged }));

    // When the core boots and the name read settles
    await boot(buildBootParams({ create: createFakeRuntimeFactory({ runtimes }) }));
    await unchanged;

    // Then the core is activated once
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user whose core is gone before my new name arrives, I boot it and am not activated again', async () => {
    // Given a network that holds a new name
    const runtimes: FakeRuntime[] = [];
    const renamed = Promise.resolve('bob.7');
    const boot = createLocalWalletCoreBoot(buildParams({ refreshLiteUsername: () => renamed }));

    // When a core that is already gone boots and the new name arrives
    await boot(buildBootParams({ create: createFakeRuntimeFactory({ runtimes }), isLive: false }));
    await renamed;

    // Then the core is activated once
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user on a page with two cores, I change my username once and both cores are activated again', async () => {
    // Given two booted cores waiting on one name read
    const refresh = createDeferred<string>();
    const runtimes: FakeRuntime[] = [];
    const changes = createChanges();
    const create = createFakeRuntimeFactory({ runtimes, activate: createAnnouncedActivation(changes) });
    const boot = createLocalWalletCoreBoot(buildParams({ refreshLiteUsername: () => refresh.promise }));
    await boot(buildBootParams({ create }));
    await boot(buildBootParams({ create }));

    // When the new name arrives
    refresh.resolve('bob.7');
    await changes.until(() => runtimes.every(runtime => runtime.activateLocalSession.mock.lastCall?.[1] === 'bob.7'));

    // Then both cores were last activated with it
    expect(runtimes.map(runtime => runtime.activateLocalSession.mock.lastCall)).toEqual([
      [ENTROPY, 'bob.7'],
      [ENTROPY, 'bob.7'],
    ]);
  });

  it('As an operator, I see a local wallet activation that fails counted here and left to its caller to report', async () => {
    // Given a signing host whose activation fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const runtimes: FakeRuntime[] = [];
    const reportFailure = vi.fn();
    const boot = createLocalWalletCoreBoot(buildParams({ reportFailure }));

    // When the core boots
    const booted = boot(
      buildBootParams({
        create: createFakeRuntimeFactory({ runtimes, activate: () => Promise.reject(new Error('bad entropy')) }),
      }),
    );

    // Then the boot rejects with the cause, the host is disposed and the failure is counted, not reported
    await expect(booted).rejects.toThrow(/activation failed/);
    await expect(booted).rejects.toHaveProperty('cause.message', 'bad entropy');
    expect(runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'activate' }]);
  });

  it('As an operator, I see a signing worker that cannot load counted here and left to its caller to report', async () => {
    // Given a signing worker that cannot load
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const reportFailure = vi.fn();
    const boot = createLocalWalletCoreBoot(
      buildParams({ reportFailure, loadSigningWorker: () => Promise.reject(new Error('chunk failed')) }),
    );

    // When the core boots
    const booted = boot(buildBootParams({ create: createFakeRuntimeFactory() }));

    // Then the boot rejects and the failure is counted, not reported
    await expect(booted).rejects.toThrow(/failed to boot/);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'boot' }]);
  });
});
