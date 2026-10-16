// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Archive tab's product files. They live only in the cross-origin sandbox, so the host reads the CID again.
// The block source is passed in because importing it here would split the host's eager modules out of preloaded chunks.

import { getBackend } from '@dotli/config';
import { loadFetch, type ArchiveFiles } from '@dotli/content';

export type ArchiveLoader = (cid: string) => Promise<ArchiveFiles>;

/** One block's bytes by CID, as the host's sandbox relay serves them. */
export type BlockSource = (cid: string) => Promise<Uint8Array>;

/** Reads over `blockSource` on the light client, and over the gateway without one. */
export function productArchiveLoader(blockSource?: BlockSource): ArchiveLoader {
  return async cid => {
    const { readArchiveFiles } = await loadFetch();
    return getBackend() === 'rpc-gateway' || blockSource === undefined
      ? readArchiveFiles(cid, { gateway: true })
      : readArchiveFiles(cid, { blockSource });
  };
}
