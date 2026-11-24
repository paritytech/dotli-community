// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { describe, expect, it, vi } from 'vitest';
import { CONTENT_ERRORS } from '@dotli/content';
import { readServedArchive } from './readServedArchive.js';

const RAW = 0x55;
const SHA2_256 = 0x12;

function rawBlock(text: string): { cid: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(text);
  return { cid: CID.createV1(RAW, create(SHA2_256, sha256(bytes))).toString(), bytes };
}

describe('readServedArchive', () => {
  it('As a visitor with the archive cache skipped, I open a product and every block comes over bitswap', async () => {
    // Given no block cache and a bitswap client that holds the block
    const { cid, bytes } = rawBlock('<p>hi</p>');
    const bitswap = { get: vi.fn(() => Promise.resolve(bytes)) };

    // When the archive is read
    const files = await readServedArchive(cid, bitswap, null);

    // Then the block was fetched over bitswap
    expect(bitswap.get).toHaveBeenCalledWith(cid);
    expect(Object.keys(files)).toEqual(['index.html']);
  });

  it('As a visitor with a warm block cache, I open a product and the cached block is not fetched over bitswap', async () => {
    // Given a cache that holds the block
    const { cid, bytes } = rawBlock('<p>hi</p>');
    const bitswap = { get: vi.fn(() => Promise.reject(new Error('unreachable'))) };
    const cache = { get: vi.fn(() => Promise.resolve(bytes)) };

    // When the archive is read
    const files = await readServedArchive(cid, bitswap, cache);

    // Then bitswap was never asked
    expect(Object.keys(files)).toEqual(['index.html']);
    expect(bitswap.get).not.toHaveBeenCalled();
  });

  it('As a visitor whose block cache holds substituted bytes, I open a product and the read is refused', async () => {
    // Given a cache that returns other bytes for the block
    const { cid } = rawBlock('<p>hi</p>');
    const bitswap = { get: vi.fn(() => Promise.reject(new Error('unreachable'))) };
    const cache = { get: vi.fn(() => Promise.resolve(new TextEncoder().encode('<p>steal()</p>'))) };

    // When the archive is read
    const read = readServedArchive(cid, bitswap, cache);

    // Then the substituted block fails its hash check
    await expect(read).rejects.toMatchObject({ name: CONTENT_ERRORS.VERIFICATION });
  });
});
