// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { bindReports } from '../testing/bindReports.js';
import { createWalletSwitch } from './createWalletSwitch.js';

type Params = {
  /** The frame's save of the local wallet, resolving by default. */
  save?: () => Promise<void>;
  /** The frame's forget of the local wallet, resolving by default. */
  forget?: () => Promise<void>;
};

const ENTROPY = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

/** A switch over a frame whose save and forget settle as given, with a fake Sentry and capture sink bound. */
function createSwitchHarness({ save: saveInFrame, forget: forgetInFrame }: Params = {}) {
  const { captures, counted } = bindReports();
  const forget = vi.fn<() => Promise<void>>(forgetInFrame ?? (() => Promise.resolve()));
  const reload = vi.fn();
  const save = vi.fn<(entropy: Uint8Array) => Promise<void>>(() => saveInFrame?.() ?? Promise.resolve());
  return {
    save,
    forget,
    reload,
    captures,
    counted,
    wallet: createWalletSwitch({ save, reload }),
  };
}

describe('wallet switch', () => {
  it('As a user, I save my wallet for every app and the page reloads into local mode', async () => {
    // Given
    const { save, reload, wallet } = createSwitchHarness();

    // When
    const outcome = await wallet.useLocalWallet(ENTROPY);

    // Then
    expect(outcome).toBe('reloading');
    expect(save).toHaveBeenCalledWith(ENTROPY);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a user whose save fails, I switch to a local wallet and stay on the page with the failure reported once', async () => {
    // Given
    const cause = new Error('frame unavailable');
    const { reload, captures, counted, wallet } = createSwitchHarness({ save: () => Promise.reject(cause) });

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
    const { forget, reload, wallet } = createSwitchHarness();

    // When
    const outcome = await wallet.usePolkadotApp(forget);

    // Then
    expect(outcome).toBe('reloading');
    expect(forget).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a user whose forget fails, I switch to Polkadot App and stay on the page with the failure reported once', async () => {
    // Given
    const cause = new Error('frame unavailable');
    const { forget, reload, captures, counted, wallet } = createSwitchHarness({ forget: () => Promise.reject(cause) });

    // When
    const outcome = await wallet.usePolkadotApp(forget);

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
