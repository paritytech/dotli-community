// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { BitswapClient } from '@dotli/bitswap';
import { getBackend, hasLightClient } from '@dotli/config';
import { createVerifyingBlockSource, readArchive, type ArchiveFiles } from '@dotli/content';

/** The block cache a read may serve from. */
export type ServedBlockCache = { get(cid: string): Promise<Uint8Array | null> };

/**
 * Reads the files `cid` names over the content backend in force: on a light client, each block from `cache`, else over
 * `bitswap`, and on rpc-gateway, the gateway. A null `cache` reads every block over `bitswap`. Rejects when a block
 * cannot be fetched or fails its hash check.
 */
export async function readServedArchive(
  cid: string,
  bitswap: Pick<BitswapClient, 'get'>,
  cache: ServedBlockCache | null,
): Promise<ArchiveFiles> {
  // These blocks bypass the relay that checks a product load's blocks, so every one is hashed here.
  const result = await readArchive(
    cid,
    hasLightClient(getBackend())
      ? { blockSource: createVerifyingBlockSource(blockCid => readBlock(blockCid.toString())) }
      : { gateway: true },
  );
  // A single file is the page the sandbox serves as index.html.
  return result.type === 'single' ? { 'index.html': result.content } : result.files;

  async function readBlock(blockCid: string): Promise<Uint8Array> {
    return (await cache?.get(blockCid)) ?? bitswap.get(blockCid);
  }
}
