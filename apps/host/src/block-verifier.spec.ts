// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createBlockVerifier } from './block-verifier.js';

describe('createBlockVerifier', () => {
  it('As a visitor whose verifier chunk fails to load, every block check fails, each tries the load again and the miss is reported once', async () => {
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

  it('As a visitor whose verifier chunk failed once, a later block check loads it and the miss was reported once', async () => {
    // Given
    const chunkMiss = new TypeError('Failed to fetch dynamically imported module');
    const blockMatchesCid = vi.fn(() => true);
    const load = vi.fn().mockRejectedValueOnce(chunkMiss).mockResolvedValue({ blockMatchesCid });
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });

    // When
    await expect(verify('bafy-a', new Uint8Array())).rejects.toBe(chunkMiss);
    const later = await verify('bafy-b', new Uint8Array());

    // Then
    expect(later).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('As a visitor, a block is checked by the verifier that loaded once', async () => {
    // Given
    const blockMatchesCid = vi.fn(() => true);
    const load = vi.fn(() => Promise.resolve({ blockMatchesCid }));
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });
    const bytes = new Uint8Array([1]);

    // When
    const ok = await verify('bafy-a', bytes);
    await verify('bafy-b', bytes);

    // Then
    expect(ok).toBe(true);
    expect(blockMatchesCid).toHaveBeenCalledWith('bafy-a', bytes);
    expect(load).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });
});
