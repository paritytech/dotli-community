// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createSyncStore } from '@dotli/shared';
import type { WalletModeState } from './state/wallet-mode.js';
import { createWalletBoot } from './wallet-boot.js';

const captures = { exception: vi.fn(), expected: vi.fn() };

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

/** A wallet boot over a frame that answers with `answer`, reporting into a fresh wallet mode store. */
function bootWith(answer: () => Promise<LocalWalletReadResult>) {
  const read = vi.fn(answer);
  const mode = createSyncStore<WalletModeState>('walletMode', { mode: 'app', failure: null });
  const walletBoot = createWalletBoot({ read, report: mode.set });
  return { read, mode, walletBoot };
}

beforeEach(() => {
  vi.clearAllMocks();
  bindCaptureSink(captures);
});

describe('wallet boot', () => {
  it('As a user with a local wallet, I boot in local mode with its entropy', async () => {
    // Given
    const wallet = { entropy: ENTROPY, identity: null };
    const { mode, walletBoot } = bootWith(() => Promise.resolve({ tag: 'ok' as const, value: wallet }));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toEqual(wallet);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
  });

  it('As a Polkadot App user, I boot the pairing host', async () => {
    // Given
    const { mode, walletBoot } = bootWith(() => Promise.resolve({ tag: 'none' as const, value: undefined }));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
  });

  it('As a user whose wallet no longer decrypts, I boot the pairing host and am told why', async () => {
    // Given
    const { mode, walletBoot } = bootWith(() => Promise.resolve({ tag: 'unreadable' as const, value: undefined }));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get().mode).toBe('app');
    expect(mode.get().failure).toMatch(/could not be decrypted/);
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'wallet',
      step: 'local_wallet',
      tags: { reason: 'unreadable' },
    });
  });

  it('As a Polkadot App user whose protocol frame never came up, I still boot the pairing host', async () => {
    // Given
    const failure = new Error('frame unavailable');
    const { mode, walletBoot } = bootWith(() => Promise.reject(failure));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get().mode).toBe('app');
    expect(mode.get().failure).toMatch(/could not be read/);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'local_wallet',
      tags: { reason: 'read' },
    });
  });

  it('As a page with several cores, I read the wallet once', async () => {
    // Given
    const { read, walletBoot } = bootWith(() => Promise.resolve({ tag: 'none' as const, value: undefined }));

    // When
    await Promise.all([walletBoot.read(), walletBoot.read()]);
    await walletBoot.read();

    // Then
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user whose shared store came back, the next read restores my local wallet', async () => {
    // Given: a first read the frame could not answer, then the frame back with the wallet
    const wallet = { entropy: ENTROPY, identity: null };
    let frameUp = false;
    const { read, mode, walletBoot } = bootWith(() =>
      frameUp ? Promise.resolve({ tag: 'ok' as const, value: wallet }) : Promise.reject(new Error('frame unavailable')),
    );
    expect(await walletBoot.read()).toBeNull();
    frameUp = true;

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toEqual(wallet);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('As a Polkadot App user whose shared store came back, I am no longer told my wallet could not be read', async () => {
    // Given
    let frameUp = false;
    const { mode, walletBoot } = bootWith(() =>
      frameUp
        ? Promise.resolve({ tag: 'none' as const, value: undefined })
        : Promise.reject(new Error('frame unavailable')),
    );
    await walletBoot.read();
    frameUp = true;

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
  });

  it('As a page whose cores ask together while the frame is down, the queued read asks the frame again', async () => {
    // Given
    const { read, walletBoot } = bootWith(() => Promise.reject(new Error('frame unavailable')));

    // When
    const boots = await Promise.all([walletBoot.read(), walletBoot.read()]);

    // Then
    expect(boots).toEqual([null, null]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('As a page whose protocol frame cannot answer, I report the outage once however many readers ask', async () => {
    // Given
    const { walletBoot } = bootWith(() => Promise.reject(new Error('frame unavailable')));

    // When
    await walletBoot.read();
    await walletBoot.read();
    await walletBoot.read();

    // Then
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });
});
