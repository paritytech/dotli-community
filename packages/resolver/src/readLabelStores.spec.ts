// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import { fromHex } from '@dotli/shared';
import type { Api } from './createRawApi.js';
import { readLabelStores } from './readLabelStores.js';
import { computeArrayElementSlot, encodeSlotKey } from './storageSlots.js';

/** The words each contract holds, by slot key. */
type Storage = Record<string, Record<string, Uint8Array>>;

const dotns = getActiveServicesConfig().dotns;
const STORES_SLOT = dotns.STORAGE_SLOTS.STORE_FACTORY_LABEL_STORES;
const BLOCK_HASH = '0x0b';
const TRIE_ID = new Uint8Array([1]);
const LABEL_STORES = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
];

const countSlot = encodeSlotKey(STORES_SLOT);

describe('readLabelStores', () => {
  it('As the name list, I read the label stores added since the last sync', async () => {
    // Given a factory that holds 3 label stores, the first of them already known
    const { api, batches } = createFakeApi(createFactoryStorage(LABEL_STORES));

    // When the label stores are read from position 1
    const stores = await readLabelStores({ api, dotns, known: 1 });

    // Then the 2nd and 3rd stores come back in order, read in one batch
    expect(stores).toEqual([LABEL_STORES[1], LABEL_STORES[2]]);
    expect(batches).toEqual([[computeArrayElementSlot(STORES_SLOT, 1), computeArrayElementSlot(STORES_SLOT, 2)]]);
  });

  it('As the name list, I read nothing past the count when no store was added', async () => {
    // Given a factory that holds 3 label stores, all of them already known
    const { api, reads } = createFakeApi(createFactoryStorage(LABEL_STORES));

    // When the label stores are read from position 3
    const stores = await readLabelStores({ api, dotns, known: 3 });

    // Then no store comes back, and only the count was read
    expect(stores).toEqual([]);
    expect(reads).toEqual([countSlot]);
  });
});

/** The factory's storage: the array's length at its slot and each store's address at its element slot. */
function createFactoryStorage(stores: string[]): Storage {
  const words: Record<string, Uint8Array> = { [countSlot]: toCountWord(stores.length) };
  for (const [index, store] of stores.entries()) {
    words[computeArrayElementSlot(STORES_SLOT, index)] = toWord(store);
  }
  return { [dotns.STORE_FACTORY]: words };
}

/**
 * An `Api` that answers slot reads from `storage` at `BLOCK_HASH`. `reads` lists every slot key read, and `batches`
 * the keys of each batched read.
 */
function createFakeApi(storage: Storage): { api: Api; reads: string[]; batches: string[][] } {
  const reads: string[] = [];
  const batches: string[][] = [];
  const api: Api = {
    whenReady: () => Promise.resolve(),
    withBestBlock: read => read(BLOCK_HASH),
    resolveTrieId: contractAddress => Promise.resolve(contractAddress in storage ? TRIE_ID : null),
    readSlot: (contractAddress, slotKey) => {
      reads.push(slotKey);
      return Promise.resolve(storage[contractAddress]?.[slotKey] ?? null);
    },
    resolveTrieIds: () => Promise.reject(new Error('The label store read resolved many trie ids')),
    readSlots: (contractAddress, slotKeys) => {
      reads.push(...slotKeys);
      batches.push([...slotKeys]);
      return Promise.resolve(slotKeys.map(slotKey => storage[contractAddress]?.[slotKey] ?? null));
    },
    onStop: () => () => undefined,
    destroy: () => undefined,
  };
  return { api, reads, batches };
}

/** An address right-aligned in a storage word. */
function toWord(address: string): Uint8Array {
  const word = new Uint8Array(32);
  word.set(fromHex(address), 12);
  return word;
}

/** A uint256 that fits its last byte. */
function toCountWord(count: number): Uint8Array {
  const word = new Uint8Array(32);
  word[31] = count;
  return word;
}
