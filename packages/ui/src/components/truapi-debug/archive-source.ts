// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where the debug panel's Archive tab gets the product's files. They exist
// only in the cross-origin sandbox, so the host reads the product's CID again
// itself, the way the sandbox read it for this backend: over the IPFS gateway
// on rpc-gateway, over bitswap otherwise.
//
// The host hands in its bitswap block source rather than this module importing
// one: the host's eager code holds those modules, and importing them from the
// panel's chunk would make the bundler split them out of the chunks the page
// preloads.

import { getBackend } from '@dotli/config';
import { loadFetch, type ArchiveFiles } from '@dotli/content';

export type ArchiveLoader = (cid: string) => Promise<ArchiveFiles>;

/** One block's bytes by CID, as the host's sandbox relay serves them. */
export type BlockSource = (cid: string) => Promise<Uint8Array>;

/** Reads over `blockSource` on the light client; over the gateway without one. */
export function productArchiveLoader(blockSource?: BlockSource): ArchiveLoader {
  return async cid => {
    const { readArchiveFiles } = await loadFetch();
    return getBackend() === 'rpc-gateway' || blockSource === undefined
      ? readArchiveFiles(cid, { gateway: true })
      : readArchiveFiles(cid, { blockSource });
  };
}
