// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import { CONTENT_ERRORS } from '@dotli/content';
import { createDeferred } from '@dotli/shared';
import { createArchiveReader } from './createArchiveReader.js';

const RAW = 0x55;
const SHA2_256 = 0x12;

type BlockCache = { get(cid: string): Promise<Uint8Array | null> };

function rawBlock(text: string): { cid: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(text);
  return { cid: CID.createV1(RAW, create(SHA2_256, sha256(bytes))).toString(), bytes };
}

function createLightClientReader(bitswap: { get(cid: string): Promise<Uint8Array> }, cache: BlockCache | null = null) {
  return createArchiveReader({ backend: (): Backend => 'smoldot-direct', bitswap, blockCache: () => cache });
}

describe('the archive reader', () => {
  it('As a visitor with the archive cache skipped, I open a product and every block comes over bitswap', async () => {
    // Given no block cache and a bitswap client that holds the block
    const { cid, bytes } = rawBlock('<p>hi</p>');
    const bitswap = { get: vi.fn(() => Promise.resolve(bytes)) };
    const reader = createLightClientReader(bitswap);

    // When the archive is read
    const files = await reader.read(cid);

    // Then the block was fetched over bitswap
    expect(bitswap.get).toHaveBeenCalledWith(cid);
    expect(Object.keys(files)).toEqual(['index.html']);
  });

  it('As a visitor with a warm block cache, I open a product and the cached block is not fetched over bitswap', async () => {
    // Given a cache that holds the block
    const { cid, bytes } = rawBlock('<p>hi</p>');
    const bitswap = { get: vi.fn(() => Promise.reject(new Error('unreachable'))) };
    const reader = createLightClientReader(bitswap, { get: () => Promise.resolve(bytes) });

    // When the archive is read
    const files = await reader.read(cid);

    // Then bitswap was never asked
    expect(Object.keys(files)).toEqual(['index.html']);
    expect(bitswap.get).not.toHaveBeenCalled();
  });

  it('As a visitor whose block cache holds substituted bytes, I open a product and the read is refused', async () => {
    // Given a cache that returns other bytes for the block
    const { cid } = rawBlock('<p>hi</p>');
    const bitswap = { get: () => Promise.reject(new Error('unreachable')) };
    const reader = createLightClientReader(bitswap, {
      get: () => Promise.resolve(new TextEncoder().encode('<p>steal()</p>')),
    });

    // When the archive is read
    const read = reader.read(cid);

    // Then the substituted block fails its hash check
    await expect(read).rejects.toMatchObject({ name: CONTENT_ERRORS.VERIFICATION });
  });

  it("As a product page whose worker and debug panel read one archive at once, I fetch the archive's block once", async () => {
    // Given a bitswap client that holds the block
    const { cid, bytes } = rawBlock('<p>hi</p>');
    const bitswap = { get: vi.fn(() => Promise.resolve(bytes)) };
    const reader = createLightClientReader(bitswap);

    // When two reads of the archive overlap
    const [first, second] = await Promise.all([reader.read(cid), reader.read(cid)]);

    // Then both get the same files from one fetch
    expect(second).toBe(first);
    expect(bitswap.get).toHaveBeenCalledTimes(1);
  });

  it('As a product page that reads an archive again later, I get the kept files without another fetch', async () => {
    // Given an archive already read once
    const { cid, bytes } = rawBlock('<p>hi</p>');
    const bitswap = { get: vi.fn(() => Promise.resolve(bytes)) };
    const reader = createLightClientReader(bitswap);
    const first = await reader.read(cid);

    // When the archive is read again
    const again = await reader.read(cid);

    // Then the kept files come back and nothing is fetched
    expect(again).toBe(first);
    expect(bitswap.get).toHaveBeenCalledTimes(1);
  });

  it('As a product page whose archive read failed, I read it again and the block is fetched anew', async () => {
    // Given a read that failed because bitswap failed once, and bitswap now holds the block
    const { cid, bytes } = rawBlock('<p>hi</p>');
    const bitswap = {
      get: vi
        .fn<(cid: string) => Promise<Uint8Array>>()
        .mockRejectedValueOnce(new Error('peer gone'))
        .mockResolvedValue(bytes),
    };
    const reader = createLightClientReader(bitswap);
    await reader.read(cid).catch(() => null);

    // When the archive is read again
    const files = await reader.read(cid);

    // Then the next read fetched the block and resolved
    expect(Object.keys(files)).toEqual(['index.html']);
    expect(bitswap.get).toHaveBeenCalledTimes(2);
  });

  it('As a product page reading two archives, I get one while the read of the other is still in flight', async () => {
    // Given a bitswap client that holds one block and is still fetching the other
    const slow = rawBlock('<p>slow</p>');
    const fast = rawBlock('<p>fast</p>');
    const slowBlock = createDeferred<Uint8Array>();
    const bitswap = { get: (cid: string) => (cid === slow.cid ? slowBlock.promise : Promise.resolve(fast.bytes)) };
    const reader = createLightClientReader(bitswap);
    void reader.read(slow.cid);

    // When the other archive is read
    const files = await reader.read(fast.cid);

    // Then it resolves while the first read still waits
    expect(Object.keys(files)).toEqual(['index.html']);
  });
});
