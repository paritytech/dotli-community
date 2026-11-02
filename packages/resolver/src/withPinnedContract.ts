// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Multi-slot reads pin one block and the contract's `trie_id`, so a best-block change mid-loop cannot return bytes torn
// across two blocks.

import type { Api } from './createRawApi.js';

/** The block a read is pinned to, and the contract's child trie in it. */
export type PinnedContract = {
  hash: string;
  trieId: Uint8Array;
};

type Params<T> = {
  api: Api;
  contractAddress: string;
  read: (pin: PinnedContract) => Promise<T | null>;
};

/** Keeps one block pinned until `read` settles. Resolves `null` without calling `read` when no contract exists. */
export function withPinnedContract<T>({ api, contractAddress, read }: Params<T>): Promise<T | null> {
  return api.withBestBlock(async hash => {
    const trieId = await api.resolveTrieId(contractAddress, hash);
    if (trieId === null) {
      return null;
    }
    return read({ hash, trieId });
  });
}
