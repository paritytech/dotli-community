// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createWalletSwitch } from './wallet-switch.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

/** A switch over a frame whose save and forget settle as given, with a fake Sentry and capture sink bound for this test. */
function switchWith(frame: { save?: () => Promise<void>; forget?: () => Promise<void> } = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const save = vi.fn<(entropy: Uint8Array) => Promise<void>>(frame.save ?? (() => Promise.resolve()));
  const forget = vi.fn<() => Promise<void>>(frame.forget ?? (() => Promise.resolve()));
  const reload = vi.fn();
  return {
    save,
    forget,
    reload,
    captures,
    counted: metrics.counted,
    wallet: createWalletSwitch({ save, forget, reload }),
  };
}

describe('wallet switch', () => {
  it('As a user, I save my wallet for every app and the page reloads into local mode', async () => {
    // Given
    const { save, reload, wallet } = switchWith();

    // When
    const outcome = await wallet.useLocalWallet(ENTROPY);

    // Then
    expect(outcome).toBe('reloading');
    expect(save).toHaveBeenCalledWith(ENTROPY);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a user whose save failed, I stay on the page and the failure is reported once', async () => {
    // Given
    const cause = new Error('frame unavailable');
    const { reload, captures, counted, wallet } = switchWith({ save: () => Promise.reject(cause) });

    // When
    const outcome = await wallet.useLocalWallet(ENTROPY);

    // Then
    expect(outcome).toBe('failed');
    expect(reload).not.toHaveBeenCalled();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Local wallet could not be saved', cause }),
      { flow: 'wallet', step: 'local_wallet', tags: { reason: 'save' } },
    );
    expect(counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'save' }]);
  });

  it('As a user, I forget my wallet for every app and the page reloads into Polkadot App mode', async () => {
    // Given
    const { forget, reload, wallet } = switchWith();

    // When
    const outcome = await wallet.usePolkadotApp();

    // Then
    expect(outcome).toBe('reloading');
    expect(forget).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a user whose forget failed, I stay on the page and the failure is reported once', async () => {
    // Given
    const cause = new Error('frame unavailable');
    const { reload, captures, counted, wallet } = switchWith({ forget: () => Promise.reject(cause) });

    // When
    const outcome = await wallet.usePolkadotApp();

    // Then
    expect(outcome).toBe('failed');
    expect(reload).not.toHaveBeenCalled();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Local wallet could not be forgotten', cause }),
      { flow: 'wallet', step: 'local_wallet', tags: { reason: 'forget' } },
    );
    expect(counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'forget' }]);
  });
});
