// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_ID } from '@dotli/config';

const protocol = vi.hoisted(() => ({
  saveSharedLocalWallet: vi.fn(),
  forgetSharedLocalWallet: vi.fn(),
}));
vi.mock('@dotli/protocol', () => protocol);

import { switchToLocalWallet, switchToPolkadotApp } from '../src/wallet-switch.js';

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('wallet switch', () => {
  it('As a user, I save my wallet for every app and the page reloads into local mode', async () => {
    // Given
    protocol.saveSharedLocalWallet.mockResolvedValue(undefined);
    const reload = vi.fn();

    // When
    await switchToLocalWallet(ENTROPY, reload);

    // Then
    expect(protocol.saveSharedLocalWallet).toHaveBeenCalledWith(SITE_ID, ENTROPY);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a user whose save failed, I stay on the page and see the failure', async () => {
    // Given
    protocol.saveSharedLocalWallet.mockRejectedValue(new Error('frame unavailable'));
    const reload = vi.fn();

    // When
    const result = switchToLocalWallet(ENTROPY, reload);

    // Then
    await expect(result).rejects.toThrow(/could not be saved/);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a user, I forget my wallet for every app and the page reloads into Polkadot App mode', async () => {
    // Given
    protocol.forgetSharedLocalWallet.mockResolvedValue(undefined);
    const reload = vi.fn();

    // When
    await switchToPolkadotApp(reload);

    // Then
    expect(protocol.forgetSharedLocalWallet).toHaveBeenCalledWith(SITE_ID);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
