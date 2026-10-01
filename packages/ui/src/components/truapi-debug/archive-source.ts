// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where the debug panel's Archive tab gets the product's files. They exist
// only in the cross-origin sandbox, so the host reads the product's CID again
// itself, the way the sandbox read it for this backend: over the IPFS gateway
// on rpc-gateway, over bitswap otherwise, with the host's block cache first.
// Nothing is written back to the cache.

import { getBackend } from '@dotli/config';
import { bitswapGet, loadFetch, type ArchiveFiles } from '@dotli/content';
import { getCachedBlock } from '@dotli/storage';

export type ArchiveLoader = (cid: string) => Promise<ArchiveFiles>;

export const loadProductArchive: ArchiveLoader = async cid => {
  const { readArchiveFiles } = await loadFetch();
  if (getBackend() === 'rpc-gateway') {
    return readArchiveFiles(cid, { gateway: true });
  }
  return readArchiveFiles(cid, {
    blockSource: async block => (await getCachedBlock(block)) ?? bitswapGet(block),
  });
};
