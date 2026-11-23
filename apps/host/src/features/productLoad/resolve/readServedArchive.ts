// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { BitswapClient } from '@dotli/bitswap';
import { getBackend, hasLightClient } from '@dotli/config';
import { readArchiveFiles, type ArchiveFiles } from '@dotli/content';
import { blockCache } from '@dotli/storage';

/**
 * Reads the files `cid` names over the content backend in force: on a light client, each block from the block cache,
 * else over `bitswap`, and on rpc-gateway, the gateway. Rejects when a block cannot be fetched or fails its hash check.
 */
export function readServedArchive(cid: string, bitswap: Pick<BitswapClient, 'get'>): Promise<ArchiveFiles> {
  return readArchiveFiles(cid, hasLightClient(getBackend()) ? { blockSource: readBlock } : { gateway: true });

  async function readBlock(blockCid: string): Promise<Uint8Array> {
    return (await blockCache.get(blockCid)) ?? bitswap.get(blockCid);
  }
}
