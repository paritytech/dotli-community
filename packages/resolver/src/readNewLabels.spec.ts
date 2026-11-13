// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import { fromHex, toHex } from '@dotli/shared';
import type { Api } from './createRawApi.js';
import { PartialStorageReadError } from './partialStorageReadError.js';
import { readNewLabels } from './readNewLabels.js';
import { addToSlot, computeArrayElementSlot, computeMappingSlot, encodeSlotKey } from './storageSlots.js';

/** The words each contract holds, by slot key. */
type Storage = Record<string, Record<string, Uint8Array>>;

/** A name to store, `null` for an unset name slot, or a long name's declared length with no data slots written. */
type StoredName = string | null | { length: number };

const dotns = getActiveServicesConfig().dotns;
const TLD = dotns.TLD;
const LIST_SLOT = dotns.STORAGE_SLOTS.LABEL_STORE_LABEL_LIST;
const LABELS_SLOT = dotns.STORAGE_SLOTS.LABEL_STORE_LABELS;
const BLOCK_HASH = '0x0b';
const TRIE_ID = new Uint8Array([1]);
const STORE = '0x1111111111111111111111111111111111111111';
const OTHER_STORE = '0x2222222222222222222222222222222222222222';
const NOT_A_CONTRACT = '0x3333333333333333333333333333333333333333';

describe('readNewLabels', () => {
  it("As the name list, I read only a store's entries past its saved count", async () => {
    // Given a store that holds 3 names, the first of them already read
    const { api } = createFakeApi({ [STORE]: createStoreWords([`alice.${TLD}`, `bob.${TLD}`, `carol.${TLD}`]) });
    const stores = [{ address: STORE, read: 1 }];

    // When the new labels are read
    const result = await readNewLabels({ api, dotns, stores });

    // Then the 2nd and 3rd labels come back, and the cursor moves to the count
    expect(result).toEqual({ stores: [{ address: STORE, read: 3 }], labels: ['bob', 'carol'] });
  });

  it("As the name list, I read at most 256 of a store's new entries at a time, and the cursor stops after them", async () => {
    // Given a store that holds 300 names
    const labels = Array.from({ length: 300 }, (_, index) => `name${String(index)}`);
    const { api } = createFakeApi({ [STORE]: createStoreWords(labels.map(label => `${label}.${TLD}`)) });
    const stores = [{ address: STORE, read: 0 }];

    // When the new labels are read
    const result = await readNewLabels({ api, dotns, stores });

    // Then the first 256 labels come back, and the cursor moves past them only
    expect(result).toEqual({ stores: [{ address: STORE, read: 256 }], labels: labels.slice(0, 256) });
  });

  it('As the name list, I keep second-level names under my TLD and drop subnames, other TLDs and invalid labels', async () => {
    // Given a store that holds a subname, another TLD's name, an uppercase punycode label, a valid name and a nested name
    const { api } = createFakeApi({
      [STORE]: createStoreWords([`app.alice.${TLD}`, 'alice.dot', `XN--a.${TLD}`, `ok.${TLD}`, `michael.01.${TLD}`]),
    });
    const stores = [{ address: STORE, read: 0 }];

    // When the new labels are read
    const { labels } = await readNewLabels({ api, dotns, stores });

    // Then only the valid second-level label comes back
    expect(labels).toEqual(['ok']);
  });

  it('As the name list, I read a name stored as a long string in full', async () => {
    // Given a store that holds a 40-byte name over two data slots
    const label = 'a'.repeat(34);
    const { api } = createFakeApi({ [STORE]: createStoreWords([`${label}.${TLD}`]) });
    const stores = [{ address: STORE, read: 0 }];

    // When the new labels are read
    const { labels } = await readNewLabels({ api, dotns, stores });

    // Then the whole label comes back
    expect(labels).toEqual([label]);
  });

  it('As the name list, I skip a name longer than any valid label without reading its data slots', async () => {
    // Given a store whose only name declares 500 bytes
    const { api, reads } = createFakeApi({ [STORE]: createStoreWords([{ length: 500 }]) });
    const stores = [{ address: STORE, read: 0 }];
    const firstDataSlot = getDataSlot(getNameSlot(0));

    // When the new labels are read
    const result = await readNewLabels({ api, dotns, stores });

    // Then no label comes back, the cursor moves past the entry, and no data slot was read
    expect(result).toEqual({ stores: [{ address: STORE, read: 1 }], labels: [] });
    expect(reads).not.toContain(firstDataSlot);
  });

  it('As the name list, I skip an entry whose name slot is unset', async () => {
    // Given a store whose first entry has no name, followed by a valid name
    const { api } = createFakeApi({ [STORE]: createStoreWords([null, `ok.${TLD}`]) });
    const stores = [{ address: STORE, read: 0 }];

    // When the new labels are read
    const result = await readNewLabels({ api, dotns, stores });

    // Then only the valid label comes back, and the cursor moves past both entries
    expect(result).toEqual({ stores: [{ address: STORE, read: 2 }], labels: ['ok'] });
  });

  it('As the name list, I list a name found in two stores once', async () => {
    // Given two stores that both hold the same name
    const { api } = createFakeApi({
      [STORE]: createStoreWords([`alice.${TLD}`, `bob.${TLD}`]),
      [OTHER_STORE]: createStoreWords([`bob.${TLD}`, `carol.${TLD}`]),
    });
    const stores = [
      { address: STORE, read: 0 },
      { address: OTHER_STORE, read: 0 },
    ];

    // When the new labels are read
    const { labels } = await readNewLabels({ api, dotns, stores });

    // Then each label comes back once, in first-seen order
    expect(labels).toEqual(['alice', 'bob', 'carol']);
  });

  it('As the name list, I keep the cursor of an address that is not a contract and add no labels', async () => {
    // Given one store and an address with no contract behind it
    const { api } = createFakeApi({ [STORE]: createStoreWords([`ok.${TLD}`]) });
    const stores = [
      { address: NOT_A_CONTRACT, read: 4 },
      { address: STORE, read: 0 },
    ];

    // When the new labels are read
    const result = await readNewLabels({ api, dotns, stores });

    // Then the address keeps its cursor, and only the store's label comes back
    expect(result).toEqual({
      stores: [
        { address: NOT_A_CONTRACT, read: 4 },
        { address: STORE, read: 1 },
      ],
      labels: ['ok'],
    });
  });

  it('As the name list, I skip an entry whose labelhash slot is unset', async () => {
    // Given a store whose first entry has no labelhash, followed by a valid name
    const unsetSlot = computeArrayElementSlot(LIST_SLOT, 0);
    const words = Object.fromEntries(
      Object.entries(createStoreWords([`gone.${TLD}`, `ok.${TLD}`])).filter(([slot]) => slot !== unsetSlot),
    );
    const { api } = createFakeApi({ [STORE]: words });
    const stores = [{ address: STORE, read: 0 }];

    // When the new labels are read
    const result = await readNewLabels({ api, dotns, stores });

    // Then only the valid label comes back, and the cursor moves past both entries
    expect(result).toEqual({ stores: [{ address: STORE, read: 2 }], labels: ['ok'] });
  });

  it('As the name list, I read several stores in one block with one trie id lookup', async () => {
    // Given two stores
    const { api, blocks, trieIdLookups } = createFakeApi({
      [STORE]: createStoreWords([`alice.${TLD}`]),
      [OTHER_STORE]: createStoreWords([`bob.${TLD}`]),
    });
    const stores = [
      { address: STORE, read: 0 },
      { address: OTHER_STORE, read: 0 },
    ];

    // When the new labels are read
    await readNewLabels({ api, dotns, stores });

    // Then one block was held, and one lookup resolved both stores
    expect(blocks).toEqual([BLOCK_HASH]);
    expect(trieIdLookups).toEqual([[STORE, OTHER_STORE]]);
  });

  it("As the name list, I reject with a partial read when a long name's data slot is missing", async () => {
    // Given a store whose only name declares 40 bytes with no data slots written
    const { api } = createFakeApi({ [STORE]: createStoreWords([{ length: 40 }]) });
    const stores = [{ address: STORE, read: 0 }];

    // When the new labels are read
    const read = readNewLabels({ api, dotns, stores });

    // Then the read rejects naming the entry's labelhash
    await expect(read).rejects.toBeInstanceOf(PartialStorageReadError);
    await expect(read).rejects.toMatchObject({
      context: { mappingKind: 'mapping string', innerKey: getLabelhash(0) },
    });
  });
});

/** A label store's storage: the list's length, each entry's labelhash, and each stored name under its labelhash. */
function createStoreWords(names: readonly StoredName[]): Record<string, Uint8Array> {
  const words: Record<string, Uint8Array> = { [encodeSlotKey(LIST_SLOT)]: toCountWord(names.length) };
  for (const [index, name] of names.entries()) {
    words[computeArrayElementSlot(LIST_SLOT, index)] = fromHex(getLabelhash(index));
    if (name === null) {
      continue;
    }
    const nameSlot = getNameSlot(index);
    if (typeof name !== 'string') {
      words[nameSlot] = toCountWord(name.length * 2 + 1);
      continue;
    }
    const bytes = new TextEncoder().encode(name);
    if (bytes.length <= 31) {
      const word = new Uint8Array(32);
      word.set(bytes);
      word[31] = bytes.length * 2;
      words[nameSlot] = word;
      continue;
    }
    words[nameSlot] = toCountWord(bytes.length * 2 + 1);
    const dataSlot = getDataSlot(nameSlot);
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const word = new Uint8Array(32);
      word.set(bytes.subarray(offset, offset + 32));
      words[addToSlot(dataSlot, offset / 32)] = word;
    }
  }
  return words;
}

/** The labelhash a store holds at an entry position. */
function getLabelhash(index: number): `0x${string}` {
  return toHex(keccak_256(new TextEncoder().encode(`entry-${String(index)}`)));
}

function getNameSlot(index: number): `0x${string}` {
  return computeMappingSlot(getLabelhash(index), LABELS_SLOT);
}

/** A long string's first data slot. */
function getDataSlot(nameSlot: `0x${string}`): `0x${string}` {
  return toHex(keccak_256(fromHex(nameSlot)));
}

/**
 * An `Api` that answers slot reads from `storage` at `BLOCK_HASH`. `reads` lists every slot key read, `blocks` lists
 * the blocks held and `trieIdLookups` lists the addresses of each batched trie id lookup.
 */
function createFakeApi(storage: Storage): { api: Api; reads: string[]; blocks: string[]; trieIdLookups: string[][] } {
  const reads: string[] = [];
  const trieIdLookups: string[][] = [];
  const blocks: string[] = [];
  const api: Api = {
    whenReady: () => Promise.resolve(),
    withBestBlock: read => {
      blocks.push(BLOCK_HASH);
      return read(BLOCK_HASH);
    },
    resolveTrieId: contractAddress => Promise.resolve(contractAddress in storage ? TRIE_ID : null),
    readSlot: (contractAddress, slotKey) => {
      reads.push(slotKey);
      return Promise.resolve(storage[contractAddress]?.[slotKey] ?? null);
    },
    resolveTrieIds: contractAddresses => {
      trieIdLookups.push([...contractAddresses]);
      return Promise.resolve(new Map(contractAddresses.map(address => [address, address in storage ? TRIE_ID : null])));
    },
    readSlots: (contractAddress, slotKeys) => {
      reads.push(...slotKeys);
      return Promise.resolve(slotKeys.map(slotKey => storage[contractAddress]?.[slotKey] ?? null));
    },
    onStop: () => () => undefined,
    destroy: () => undefined,
  };
  return { api, reads, blocks, trieIdLookups };
}

/** A uint256 that fits its last two bytes. */
function toCountWord(count: number): Uint8Array {
  const word = new Uint8Array(32);
  word[30] = count >> 8;
  word[31] = count & 0xff;
  return word;
}
