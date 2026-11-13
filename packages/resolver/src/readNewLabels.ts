// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotnsContracts } from '@dotli/config';
import { toHex } from '@dotli/shared';
import type { Api } from './createRawApi.js';
import { isValidDotLabel, MAX_LABEL_LENGTH } from './dotLabel.js';
import { PartialStorageReadError } from './partialStorageReadError.js';
import { readArrayTail } from './readArrayTail.js';
import { addToSlot, computeMappingSlot, decodeBytesSlot } from './storageSlots.js';

/** One label store and how many of its entries were read. */
export type LabelStoreCursor = { address: string; read: number };

type Params = {
  api: Api;
  dotns: DotnsContracts;
  stores: readonly LabelStoreCursor[];
};

type ReadStoreNamesParams = {
  api: Api;
  dotns: DotnsContracts;
  store: LabelStoreCursor;
  at: { atHash: string; trieId: Uint8Array };
};

type StoreNames = { cursor: LabelStoreCursor; names: string[] };

/**
 * Each store's new entry count, and the second-level labels under `dotns.TLD` among the entries from each store's
 * `read` up to that count, deduped in first-seen order. All stores are read in one block. Rejects with
 * `PartialStorageReadError` when a long name's data slot is missing, and otherwise with a slot read's error.
 */
export function readNewLabels({
  api,
  dotns,
  stores,
}: Params): Promise<{ stores: LabelStoreCursor[]; labels: string[] }> {
  // One block for every store, so no cursor runs ahead of the names read with it.
  return api.withBestBlock(async hash => {
    const trieIds = await api.resolveTrieIds(
      stores.map(s => s.address),
      hash,
    );
    const reads = stores.map(store => {
      const trieId = trieIds.get(store.address) ?? null;
      if (trieId === null) {
        return Promise.resolve<StoreNames>({ cursor: store, names: [] });
      }
      return readStoreNames({ api, dotns, store, at: { atHash: hash, trieId } });
    });
    // Every store settles before the merge, so the first failing store decides the error and the pin outlives every
    // read.
    const settled = await Promise.allSettled(reads);
    const cursors: LabelStoreCursor[] = [];
    const labels = new Set<string>();
    const suffix = `.${dotns.TLD}`;
    for (const result of settled) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      cursors.push(result.value.cursor);
      for (const name of result.value.names) {
        const head = name.slice(0, -suffix.length);
        if (name.endsWith(suffix) && isValidDotLabel(head)) {
          labels.add(head);
        }
      }
    }
    return { stores: cursors, labels: [...labels] };
  });
}

/** The names a store added past its cursor, in entry order, with the cursor moved to the store's count. */
async function readStoreNames({ api, dotns, store, at }: ReadStoreNamesParams): Promise<StoreNames> {
  const { count, words: labelhashWords } = await readArrayTail({
    api,
    contractAddress: store.address,
    slot: dotns.STORAGE_SLOTS.LABEL_STORE_LABEL_LIST,
    from: store.read,
    at,
  });
  if (labelhashWords.length === 0) {
    return { cursor: store, names: [] };
  }

  const entries = labelhashWords.flatMap(word => {
    if (word === null) {
      return [];
    }
    const labelhash = toHex(word);
    return [{ labelhash, nameSlot: computeMappingSlot(labelhash, dotns.STORAGE_SLOTS.LABEL_STORE_LABELS) }];
  });

  const nameWords = await api.readSlots(
    store.address,
    entries.map(e => e.nameSlot),
    at,
  );
  // No second-level name is longer, and a corrupt length must not read data slots without end.
  const maxNameLength = MAX_LABEL_LENGTH + 1 + dotns.TLD.length;
  const stored = entries.flatMap(({ labelhash, nameSlot }, index) => {
    const word = nameWords[index] ?? null;
    const bytes = word === null ? null : decodeBytesSlot(word, nameSlot);
    if (bytes === null || (!bytes.inline && bytes.length > maxNameLength)) {
      return [];
    }
    return [{ labelhash, bytes }];
  });

  const dataSlots = stored.flatMap(({ bytes }) =>
    bytes.inline
      ? []
      : Array.from({ length: Math.ceil(bytes.length / 32) }, (_, index) => addToSlot(bytes.dataSlot, index)),
  );
  const dataWords = await api.readSlots(store.address, dataSlots, at);

  const decoder = new TextDecoder();
  const names: string[] = [];
  let nextDataWord = 0;
  for (const { labelhash, bytes } of stored) {
    if (bytes.inline) {
      names.push(decoder.decode(bytes.data));
      continue;
    }
    const slotsExpected = Math.ceil(bytes.length / 32);
    const data = new Uint8Array(slotsExpected * 32);
    for (let slotIndex = 0; slotIndex < slotsExpected; slotIndex++) {
      const word = dataWords[nextDataWord + slotIndex] ?? null;
      if (word === null) {
        throw new PartialStorageReadError({
          contractAddress: store.address,
          slotIndex,
          slotsExpected,
          context: { mappingKind: 'mapping string', innerKey: labelhash },
        });
      }
      data.set(word, slotIndex * 32);
    }
    nextDataWord += slotsExpected;
    names.push(decoder.decode(data.subarray(0, bytes.length)));
  }
  return { cursor: { address: store.address, read: count }, names };
}
