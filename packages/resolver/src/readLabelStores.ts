// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { readArrayTail } from './readArrayTail.js';
import { extractAddress } from './storageSlots.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  known: number;
};

/**
 * The addresses of the label stores at index `known` and above, in creation order, read in one block. Rejects with a
 * slot read's error.
 */
export function readLabelStores({ api, dotns, known }: Params): Promise<string[]> {
  // One block for the count and the elements, so a store added between the two reads cannot shift them.
  return api.withBestBlock(async hash => {
    // Resolved once, so neither read resolves it again.
    const trieId = await api.resolveTrieId(dotns.STORE_FACTORY, hash);
    if (trieId === null) {
      return [];
    }
    const { words } = await readArrayTail({
      api,
      contractAddress: dotns.STORE_FACTORY,
      slot: dotns.STORAGE_SLOTS.STORE_FACTORY_LABEL_STORES,
      from: known,
      at: { atHash: hash, trieId },
    });
    // An unset element reads as the zero address, so each position keeps its entry.
    return words.map(word => extractAddress(word ?? new Uint8Array(32)));
  });
}
