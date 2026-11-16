// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createBlockVerifier } from './createBlockVerifier.js';

describe('createBlockVerifier', () => {
  it('As a visitor, I open a product and the verifier chunk starts loading before any block is checked', () => {
    // Given a verifier that matches every block and a report spy
    const isBlockMatchingCid = vi.fn(() => true);
    const load = vi.fn(() => Promise.resolve({ isBlockMatchingCid }));
    const report = vi.fn();

    // When the verifier is created
    createBlockVerifier({ load, report });

    // Then the chunk load started once and nothing was reported
    expect(load).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('As a visitor whose verifier chunk fails to load, I check two blocks and each fails and loads again while the miss is reported once', async () => {
    // Given a chunk load that always fails and two blocks to check
    const chunkMiss = new TypeError('Failed to fetch dynamically imported module');
    const load = vi.fn(() => Promise.reject(chunkMiss));
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });

    // When both blocks are verified at once
    const first = verify('bafy-a', new Uint8Array());
    const second = verify('bafy-b', new Uint8Array());

    // Then both reject with the miss, each loads again, and one miss is reported
    await expect(first).rejects.toBe(chunkMiss);
    await expect(second).rejects.toBe(chunkMiss);
    expect(load).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('block_verifier_load', chunkMiss);
  });

  it('As a visitor whose verifier chunk failed while the page opened, I check a block and it loads while the miss stays reported once', async () => {
    // Given a chunk load that fails once and then succeeds
    const chunkMiss = new TypeError('Failed to fetch dynamically imported module');
    const isBlockMatchingCid = vi.fn(() => true);
    const load = vi.fn().mockRejectedValueOnce(chunkMiss).mockResolvedValue({ isBlockMatchingCid });
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });

    // When a block is verified
    const matched = await verify('bafy-a', new Uint8Array());

    // Then the retry loads the verifier and the first miss is reported once
    expect(matched).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('block_verifier_load', chunkMiss);
  });

  it('As a visitor, I check two blocks and both go through the verifier that loaded once', async () => {
    // Given a verifier that loads and matches every block
    const isBlockMatchingCid = vi.fn(() => true);
    const load = vi.fn(() => Promise.resolve({ isBlockMatchingCid }));
    const report = vi.fn();
    const verify = createBlockVerifier({ load, report });
    const bytes = new Uint8Array([1]);

    // When two blocks are verified in turn
    const matched = await verify('bafy-a', bytes);
    await verify('bafy-b', bytes);

    // Then both go through the one loaded verifier and nothing is reported
    expect(matched).toBe(true);
    expect(isBlockMatchingCid).toHaveBeenCalledWith('bafy-a', bytes);
    expect(load).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });
});
