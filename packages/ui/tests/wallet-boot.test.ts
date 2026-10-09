// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { readWalletBoot as ReadWalletBoot } from '../src/wallet-boot.js';
import type { WalletModeState } from '../src/state/wallet-mode.js';

const protocol = vi.hoisted(() => ({ readSharedLocalWallet: vi.fn() }));
vi.mock('@dotli/protocol', () => protocol);

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), recordExpected: vi.fn() }));
vi.mock('../../metrics/src/sentry.js', () => sentry);

const metrics = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock('../../metrics/src/metrics.js', () => ({ m: { count: metrics.count }, getResolutionId: vi.fn(() => null) }));

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

async function load(): Promise<{
  readWalletBoot: typeof ReadWalletBoot;
  getState: () => WalletModeState;
}> {
  const [{ readWalletBoot }, { walletModeStore }] = await Promise.all([
    import('../src/wallet-boot.js'),
    import('../src/state/wallet-mode.js'),
  ]);
  return { readWalletBoot, getState: walletModeStore.get };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('readWalletBoot', () => {
  it('As a user with a local wallet, I boot in local mode with its entropy', async () => {
    // Given
    const wallet = { status: 'ok', entropy: ENTROPY, identity: null };
    protocol.readSharedLocalWallet.mockResolvedValue(wallet);
    const { readWalletBoot, getState } = await load();

    // When
    const boot = await readWalletBoot();

    // Then
    expect(boot).toEqual(wallet);
    expect(getState()).toEqual({ mode: 'local', failure: null });
  });

  it('As a Polkadot App user, I boot the pairing host', async () => {
    // Given
    protocol.readSharedLocalWallet.mockResolvedValue({ status: 'none' });
    const { readWalletBoot, getState } = await load();

    // When
    const boot = await readWalletBoot();

    // Then
    expect(boot).toBeNull();
    expect(getState()).toEqual({ mode: 'app', failure: null });
  });

  it('As a user whose wallet no longer decrypts, I boot the pairing host and am told why', async () => {
    // Given
    protocol.readSharedLocalWallet.mockResolvedValue({ status: 'unreadable' });
    const { readWalletBoot, getState } = await load();

    // When
    const boot = await readWalletBoot();

    // Then
    expect(boot).toBeNull();
    expect(getState().mode).toBe('app');
    expect(getState().failure).toMatch(/could not be decrypted/);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(metrics.count).toHaveBeenCalledWith('wallet.local_activate', { outcome: 'error', reason: 'unreadable' });
  });

  it('As a Polkadot App user whose protocol frame never came up, I still boot the pairing host', async () => {
    // Given
    protocol.readSharedLocalWallet.mockRejectedValue(new Error('frame unavailable'));
    const { readWalletBoot, getState } = await load();

    // When
    const boot = await readWalletBoot();

    // Then
    expect(boot).toBeNull();
    expect(getState().mode).toBe('app');
    expect(metrics.count).toHaveBeenCalledWith('wallet.local_activate', { outcome: 'error', reason: 'read' });
  });

  it('As a page with several cores, I read the wallet once', async () => {
    // Given
    protocol.readSharedLocalWallet.mockResolvedValue({ status: 'none' });
    const { readWalletBoot } = await load();

    // When
    await Promise.all([readWalletBoot(), readWalletBoot()]);

    // Then
    expect(protocol.readSharedLocalWallet).toHaveBeenCalledTimes(1);
  });
});
