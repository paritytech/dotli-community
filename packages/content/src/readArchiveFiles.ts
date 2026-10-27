// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CID } from 'multiformats/cid';
import { readViaBitswap, readViaGateway } from './readArchive.js';
import type { ArchiveFiles, BitswapBlockSource } from './types.js';
import { createVerifyingBlockSource } from './verify.js';

/**
 * Reads the files a CID names, with no marks or metrics, for reads that are not a product load. Rejects when a block
 * cannot be fetched or fails its hash check.
 *
 * Its block source may bypass the host's relay, so every block is hashed here.
 */
export async function readArchiveFiles(
  cid: string,
  transport: { blockSource: BitswapBlockSource } | { gateway: true; fetch?: typeof fetch },
): Promise<ArchiveFiles> {
  const result =
    'blockSource' in transport
      ? await readViaBitswap({
          rootCid: CID.parse(cid),
          verifiedSource: createVerifyingBlockSource(blockCid => transport.blockSource(blockCid.toString())),
        })
      : await readViaGateway({ cid, fetch: transport.fetch ?? fetch });
  return result.type === 'single' ? { 'index.html': result.content } : result.files;
}
