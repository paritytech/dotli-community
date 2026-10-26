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
import { createLocalWalletCoreBoot, watchIdentityAccount, type LocalWalletCoreDeps } from './local-wallet-core.js';
import { createChanges, type Changes } from '../testing/changes.js';
import type { LocalWalletBoot } from './wallet-boot.js';

const PUBLIC_KEY = `0x${'01'.repeat(32)}` as const;
const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}` as const;

/** Host callbacks whose auth presenter records each state, the only callback this watch touches. */
function recordingCallbacks(states: AuthState[]): WebWorkerHostCallbacks {
  return {
    auth: {
      authStateChanged(state) {
        states.push(state);
      },
    },
  } as WebWorkerHostCallbacks;
}

describe('local wallet core identity', () => {
  it('As a local wallet user, my core reports my identity account and session state still hears every state', async () => {
    // Given
    const states: AuthState[] = [];
    const watched = watchIdentityAccount(recordingCallbacks(states));
    const connected: AuthState = {
      tag: 'Connected',
      value: { publicKey: PUBLIC_KEY, identityAccountId: IDENTITY_ACCOUNT },
    };

    // When
    watched.callbacks.auth.authStateChanged({ tag: 'Authenticating' });
    watched.callbacks.auth.authStateChanged(connected);

    // Then
    await expect(watched.identityAccountId).resolves.toBe(IDENTITY_ACCOUNT);
    expect(states).toEqual([{ tag: 'Authenticating' }, connected]);
  });
});

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const WALLET: LocalWalletBoot = {
  status: 'ok',
  entropy: ENTROPY,
  identity: { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' },
  version: Uint8Array.of(1),
};
const HOST_CONFIG = { host: { name: 'Polkadot Web' } } as WebWorkerHostConfig;

class FakeSigningWorker {
  readonly role = 'signing';
}

interface FakeRuntime {
  activateLocalSession: ReturnType<typeof vi.fn<(secret: Uint8Array, name?: string) => Promise<void>>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

function fakeRuntime(activate: () => Promise<void> = () => Promise.resolve()): FakeRuntime {
  return {
    activateLocalSession: vi.fn(activate),
    dispose: vi.fn(),
  };
}

/** A signing host maker that records what it was asked to build. */
function fakeCreate(runtimes: FakeRuntime[], activate?: () => Promise<void>, reports?: AuthState) {
  return vi.fn(
    (_worker: Worker, callbacks: WebWorkerHostCallbacks, _options: CreateWebWorkerPairingHostRuntimeOptions) => {
      if (reports !== undefined) {
        callbacks.auth.authStateChanged(reports);
      }
      const runtime = fakeRuntime(activate);
      runtimes.push(runtime);
      return Promise.resolve(runtime as unknown as WorkerPairingHostRuntime);
    },
  );
}

/** An activation that succeeds and tells `changes`, so a test waits for a later one rather than polling. */
function announcedActivation(changes: Changes): () => Promise<void> {
  return () => {
    changes.notify();
    return Promise.resolve();
  };
}

function deps(overrides: Partial<LocalWalletCoreDeps> = {}): LocalWalletCoreDeps {
  return {
    loadSigningWorker: () => Promise.resolve({ default: FakeSigningWorker as unknown as new () => Worker }),
    refreshLiteUsername: () => Promise.resolve(undefined),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

describe('local wallet core', () => {
  it('As a local wallet user, I boot a signing host and activate it with my cached name', async () => {
    // Given
    const runtimes: FakeRuntime[] = [];
    const create = fakeCreate(runtimes);
    const boot = createLocalWalletCoreBoot(deps());

    // When
    await boot(create, recordingCallbacks([]), HOST_CONFIG, WALLET, () => true);

    // Then
    const [worker, , options] = create.mock.calls[0] ?? [];
    expect(worker).toBeInstanceOf(FakeSigningWorker);
    expect(options?.role).toBe('signing');
    expect(options?.hostConfig.networkSuffix).toBe('paseo');
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledWith(ENTROPY, 'alice.42');
  });

  it('As a local wallet user, my username is read for the identity account my core reports', async () => {
    // Given
    const states: AuthState[] = [];
    const connected: AuthState = {
      tag: 'Connected',
      value: { publicKey: PUBLIC_KEY, identityAccountId: IDENTITY_ACCOUNT },
    };
    const refreshLiteUsername = vi.fn<LocalWalletCoreDeps['refreshLiteUsername']>(() => Promise.resolve(undefined));
    const boot = createLocalWalletCoreBoot(deps({ refreshLiteUsername }));

    // When
    await boot(fakeCreate([], undefined, connected), recordingCallbacks(states), HOST_CONFIG, WALLET, () => true);

    // Then
    const [wallet, identityAccountId] = refreshLiteUsername.mock.calls[0] ?? [];
    expect(wallet).toBe(WALLET);
    await expect(identityAccountId).resolves.toBe(IDENTITY_ACCOUNT);
    expect(states).toEqual([connected]);
  });

  it('As a local wallet user whose username changed, I am activated again with the new name', async () => {
    // Given
    const runtimes: FakeRuntime[] = [];
    const changes = createChanges();
    const boot = createLocalWalletCoreBoot(deps({ refreshLiteUsername: () => Promise.resolve('bob.7') }));

    // When
    await boot(
      fakeCreate(runtimes, announcedActivation(changes)),
      recordingCallbacks([]),
      HOST_CONFIG,
      WALLET,
      () => true,
    );

    // Then
    await changes.until(() => runtimes[0]?.activateLocalSession.mock.lastCall?.[1] === 'bob.7');
    expect(runtimes[0]?.activateLocalSession).toHaveBeenLastCalledWith(ENTROPY, 'bob.7');
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(2);
  });

  it('As a local wallet user whose username is unchanged, I am activated once', async () => {
    // Given
    const runtimes: FakeRuntime[] = [];
    const unchanged = Promise.resolve(undefined);
    const boot = createLocalWalletCoreBoot(deps({ refreshLiteUsername: () => unchanged }));

    // When
    await boot(fakeCreate(runtimes), recordingCallbacks([]), HOST_CONFIG, WALLET, () => true);
    await unchanged;

    // Then
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user whose core is gone before my new name arrives, I am not activated again', async () => {
    // Given
    const runtimes: FakeRuntime[] = [];
    const renamed = Promise.resolve('bob.7');
    const boot = createLocalWalletCoreBoot(deps({ refreshLiteUsername: () => renamed }));

    // When
    await boot(fakeCreate(runtimes), recordingCallbacks([]), HOST_CONFIG, WALLET, () => false);
    await renamed;

    // Then
    expect(runtimes[0]?.activateLocalSession).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user on a page with two cores, I get both re-activated by one username change', async () => {
    // Given
    let changed!: (name: string) => void;
    const refresh = new Promise<string>(resolve => {
      changed = resolve;
    });
    const runtimes: FakeRuntime[] = [];
    const changes = createChanges();
    const create = fakeCreate(runtimes, announcedActivation(changes));
    const boot = createLocalWalletCoreBoot(deps({ refreshLiteUsername: () => refresh }));
    await boot(create, recordingCallbacks([]), HOST_CONFIG, WALLET, () => true);
    await boot(create, recordingCallbacks([]), HOST_CONFIG, WALLET, () => true);

    // When
    changed('bob.7');

    // Then
    await changes.until(() => runtimes.every(runtime => runtime.activateLocalSession.mock.lastCall?.[1] === 'bob.7'));
    expect(runtimes[0]?.activateLocalSession).toHaveBeenLastCalledWith(ENTROPY, 'bob.7');
    expect(runtimes[1]?.activateLocalSession).toHaveBeenLastCalledWith(ENTROPY, 'bob.7');
  });

  it('As an operator, a local wallet activation that fails is counted here and left to its caller to report', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const runtimes: FakeRuntime[] = [];
    const reportFailure = vi.fn();
    const boot = createLocalWalletCoreBoot(deps({ reportFailure }));

    // When
    const booted = boot(
      fakeCreate(runtimes, () => Promise.reject(new Error('bad entropy'))),
      recordingCallbacks([]),
      HOST_CONFIG,
      WALLET,
      () => true,
    );

    // Then
    await expect(booted).rejects.toThrow(/activation failed/);
    await expect(booted).rejects.toHaveProperty('cause.message', 'bad entropy');
    expect(runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'activate' }]);
  });

  it('As an operator, a signing worker that cannot load is counted here and left to its caller to report', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const reportFailure = vi.fn();
    const boot = createLocalWalletCoreBoot(
      deps({ reportFailure, loadSigningWorker: () => Promise.reject(new Error('chunk failed')) }),
    );

    // When
    const booted = boot(fakeCreate([]), recordingCallbacks([]), HOST_CONFIG, WALLET, () => true);

    // Then
    await expect(booted).rejects.toThrow(/failed to boot/);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'boot' }]);
  });
});
