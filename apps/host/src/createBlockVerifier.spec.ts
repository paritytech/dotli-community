// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createBlockVerifier } from './createBlockVerifier.js';

describe('createBlockVerifier', () => {
  it('As a visitor whose verifier chunk fails to load, I check two blocks and each fails and tries the load again while the miss is reported once', async () => {
    // Given
    const chunkMiss = new TypeError('Failed to fetch dynamically imported module');
    const load = vi.fn(() => Promise.reject(chunkMiss));
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });

    // When
    const first = verify('bafy-a', new Uint8Array());
    const second = verify('bafy-b', new Uint8Array());

    // Then
    await expect(first).rejects.toBe(chunkMiss);
    await expect(second).rejects.toBe(chunkMiss);
    expect(load).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('block_verifier_load', chunkMiss);
  });

  it('As a visitor whose verifier chunk failed once, I check a later block and it loads while the miss stays reported once', async () => {
    // Given
    const chunkMiss = new TypeError('Failed to fetch dynamically imported module');
    const isBlockMatchingCid = vi.fn(() => true);
    const load = vi.fn().mockRejectedValueOnce(chunkMiss).mockResolvedValue({ isBlockMatchingCid });
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });

    // When
    const first = verify('bafy-a', new Uint8Array());
    await Promise.allSettled([first]);
    const later = await verify('bafy-b', new Uint8Array());

    // Then
    await expect(first).rejects.toBe(chunkMiss);
    expect(later).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('As a visitor, I check two blocks and both go through the verifier that loaded once', async () => {
    // Given
    const isBlockMatchingCid = vi.fn(() => true);
    const load = vi.fn(() => Promise.resolve({ isBlockMatchingCid }));
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });
    const bytes = new Uint8Array([1]);

    // When
    const matched = await verify('bafy-a', bytes);
    await verify('bafy-b', bytes);

    // Then
    expect(matched).toBe(true);
    expect(isBlockMatchingCid).toHaveBeenCalledWith('bafy-a', bytes);
    expect(load).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });
});
