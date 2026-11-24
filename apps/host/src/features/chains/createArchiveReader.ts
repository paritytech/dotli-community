// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one archive reader. Every archive the host reads goes through it, so overlapping reads of one CID share a
// read and each archive is read once per page.

import type { BitswapClient } from '@dotli/bitswap';
import { getBackend, getCacheSettings, hasLightClient, type Backend } from '@dotli/config';
import { createVerifyingBlockSource, readArchive, type ArchiveFiles } from '@dotli/content';
import { createAsyncTaskPool } from '@dotli/shared';
import { blockCache } from '@dotli/storage';
import { hostBitswapClient } from './createHostBitswapClient.js';

type Params = {
  /** The content backend in force, read at each read. */
  backend: () => Backend;
  /** Fetches the blocks the block cache misses on a light client. */
  bitswap: Pick<BitswapClient, 'get'>;
  /** The block cache a light client read serves from, read at each read. Null reads every block over `bitswap`. */
  blockCache: () => Pick<typeof blockCache, 'get'> | null;
};

/** Creates a reader that dedupes overlapping reads of one CID and keeps each archive's files for its own life. */
export function createArchiveReader({ backend, bitswap, blockCache: readBlockCache }: Params) {
  // One pool of size 1 per CID, so an overlapping call waits for the read in flight and finds its files kept.
  const reads = createAsyncTaskPool({ poolSize: 1 });
  const kept = new Map<string, ArchiveFiles>();

  return {
    /**
     * Resolves the files `cid` names, read once and kept. A single file is the page the sandbox serves as
     * `index.html`. Overlapping calls for one CID share one read. Rejects when a block cannot be fetched or fails its
     * hash check, and keeps nothing, so the next call reads again.
     */
    read(cid: string): Promise<ArchiveFiles> {
      return reads.call(() => readOnce(cid), { pool: cid });
    },
  };

  async function readOnce(cid: string): Promise<ArchiveFiles> {
    const known = kept.get(cid);
    if (known !== undefined) {
      return known;
    }
    const files = await readServed(cid);
    kept.set(cid, files);
    return files;
  }

  async function readServed(cid: string): Promise<ArchiveFiles> {
    const cache = readBlockCache();
    // These blocks bypass the relay that checks a product load's blocks, so every one is hashed here.
    const result = await readArchive(
      cid,
      hasLightClient(backend())
        ? {
            kind: 'blockSource',
            blockSource: createVerifyingBlockSource(
              async blockCid => (await cache?.get(blockCid.toString())) ?? bitswap.get(blockCid.toString()),
            ),
          }
        : { kind: 'gateway' },
    );
    return result.type === 'single' ? { 'index.html': result.content } : result.files;
  }
}

/** The page's archive reader over the content backend in force, from the block cache unless the settings skip it. */
export const hostArchiveReader = createArchiveReader({
  backend: getBackend,
  bitswap: hostBitswapClient,
  blockCache: () => (getCacheSettings().skipArchiveCache ? null : blockCache),
});
