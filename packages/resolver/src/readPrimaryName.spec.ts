// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import { fromHex, toHex } from '@dotli/shared';
import type { Api } from './createRawApi.js';
import { readPrimaryName } from './readPrimaryName.js';
import { computeMappingSlot, computeNamehash, encodeSlotKey } from './storageSlots.js';

/** The words each contract holds, by slot key. */
type Storage = Record<string, Record<string, Uint8Array>>;

const dotns = getActiveServicesConfig().dotns;
const ADDRESS = '0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20';
const OTHER_ADDRESS = '0xa7a4507c2b40d34303a7b284adcabbe41162b060';
const PROTOCOL_REGISTRY = '0xd19e3d0c97cf501125a04a97405e3e6592fa846e';
const REVERSE_RESOLVER = '0xee3883d7eb60ee9bcd7f3bcd8f2f05302a9cc035';
const LABEL = 'alice';
const NAME = `${LABEL}.${dotns.TLD}`;
/** A device name's labels: a stem over a two-digit node. */
const DEVICE_LABEL = 'alice.01';
/** A subname under the author's own name whose first letter is a Cyrillic `а`, so it reads as `paypal`. */
const LOOKALIKE_LABEL = `p\u0430ypal.${LABEL}`;
const TRIE_ID = new Uint8Array([1]);

const protocolRegistrySlot = encodeSlotKey(dotns.STORAGE_SLOTS.REGISTRY_PROTOCOL_REGISTRY);
const reverseResolverSlot = computeMappingSlot(
  toBytes32('reverseResolver'),
  dotns.STORAGE_SLOTS.PROTOCOL_REGISTRY_ADDRESSES,
);
const nameSlot = computeMappingSlot(
  `0x${ADDRESS.slice(2).padStart(64, '0')}`,
  dotns.STORAGE_SLOTS.REVERSE_RESOLVER_NAMES,
);

describe('readPrimaryName', () => {
  it('As a visitor of an author who owns their primary name, I see that name', async () => {
    // Given an address whose stored name it owns
    const { api } = createFakeApi(createStorage());

    // When its primary name is read
    const name = await readPrimaryName({ api, dotns, address: ADDRESS });

    // Then the stored name is its primary name
    expect(name).toBe(NAME);
  });

  it('As a visitor of an author whose address comes in upper case, I see their primary name', async () => {
    // Given an address whose stored name it owns
    const { api } = createFakeApi(createStorage());

    // When its primary name is read with the address in upper case
    const name = await readPrimaryName({ api, dotns, address: `0x${ADDRESS.slice(2).toUpperCase()}` });

    // Then the stored name is its primary name
    expect(name).toBe(NAME);
  });

  it('As a visitor of an author whose primary name is a device name, I see that name', async () => {
    // Given an address that stored a device name and owns it
    const storage = createStorage();
    storeName(storage, new TextEncoder().encode(`${DEVICE_LABEL}.${dotns.TLD}`));
    ownLabel(storage, DEVICE_LABEL, ADDRESS);
    const { api } = createFakeApi(storage);

    // When its primary name is read
    const name = await readPrimaryName({ api, dotns, address: ADDRESS });

    // Then the device name is its primary name
    expect(name).toBe(`${DEVICE_LABEL}.${dotns.TLD}`);
  });

  it.each([
    [
      'a network that lists no ReverseResolver',
      (storage: Storage) => {
        storage[PROTOCOL_REGISTRY] = {};
      },
    ],
    [
      'an address that stored no name',
      (storage: Storage) => {
        storage[REVERSE_RESOLVER] = {};
      },
    ],
    [
      'a name another address owns',
      (storage: Storage) => {
        ownLabel(storage, LABEL, OTHER_ADDRESS);
      },
    ],
    [
      'a name under another TLD of the same length',
      (storage: Storage) => {
        storeName(storage, new TextEncoder().encode(`${LABEL}.${'z'.repeat(dotns.TLD.length)}`));
      },
    ],
    [
      'a name with an empty label',
      (storage: Storage) => {
        storeName(storage, new TextEncoder().encode(`.${dotns.TLD}`));
        ownLabel(storage, '', ADDRESS);
      },
    ],
    [
      'a name whose label has a lookalike letter',
      (storage: Storage) => {
        storeName(storage, new TextEncoder().encode(`${LOOKALIKE_LABEL}.${dotns.TLD}`));
        ownLabel(storage, LOOKALIKE_LABEL, ADDRESS);
      },
    ],
    [
      'a name that is not UTF-8',
      (storage: Storage) => {
        storeName(storage, new Uint8Array([0xff, ...new TextEncoder().encode(`.${dotns.TLD}`)]));
        ownLabel(storage, '�', ADDRESS);
      },
    ],
  ])('As a visitor of an author with %s, I see no primary name', async (_case, change) => {
    // Given an address whose name fails one check, with the label a read would take owned by the address
    const storage = createStorage();
    change(storage);
    const { api } = createFakeApi(storage);

    // When its primary name is read
    const name = await readPrimaryName({ api, dotns, address: ADDRESS });

    // Then the address has no primary name
    expect(name).toBeNull();
  });

  it('As a visitor of an author whose address is malformed, I see no primary name', async () => {
    // Given an address that is not 20 bytes of hex
    const { api } = createFakeApi(createStorage());

    // When its primary name is read
    const name = await readPrimaryName({ api, dotns, address: `0x${'z'.repeat(40)}` });

    // Then the address has no primary name
    expect(name).toBeNull();
  });

  it('As a visitor, I see the primary name read fail when a slot read fails', async () => {
    // Given storage whose every slot read rejects
    const failure = new Error('storage read failed');
    const { api } = createFakeApi(createStorage(), failure);

    // When the primary name is read
    const name = readPrimaryName({ api, dotns, address: ADDRESS });

    // Then the read rejects with the slot read failure
    await expect(name).rejects.toBe(failure);
  });

  it('As a visitor, I read the stored name and its owner at one block', async () => {
    // Given an address whose stored name it owns, on a chain whose best block moves with every pin
    const { api, blocks } = createFakeApi(createStorage());

    // When its primary name is read
    await readPrimaryName({ api, dotns, address: ADDRESS });

    // Then every read used the same block
    expect(new Set(blocks).size).toBe(1);
  });
});

/** The storage of an address that stored `NAME` and owns it through its Registry record. */
function createStorage(): Storage {
  const storage: Storage = {
    [dotns.DOTNS_REGISTRY]: { [protocolRegistrySlot]: toWord(PROTOCOL_REGISTRY) },
    [PROTOCOL_REGISTRY]: { [reverseResolverSlot]: toWord(REVERSE_RESOLVER) },
    [REVERSE_RESOLVER]: {},
  };
  storeName(storage, new TextEncoder().encode(NAME));
  ownLabel(storage, LABEL, ADDRESS);
  return storage;
}

/** Stores a short Solidity string as the address's name: its bytes inline, with twice its length in the last byte. */
function storeName(storage: Storage, bytes: Uint8Array): void {
  const word = new Uint8Array(32);
  word.set(bytes);
  word[31] = bytes.length * 2;
  storage[REVERSE_RESOLVER] = { [nameSlot]: word };
}

/** Makes `owner` the owner its Registry record holds for `label` under the network's TLD. */
function ownLabel(storage: Storage, label: string, owner: string): void {
  const node = computeNamehash(`${label}.${dotns.TLD}`);
  storage[dotns.DOTNS_REGISTRY] = {
    ...storage[dotns.DOTNS_REGISTRY],
    [computeMappingSlot(node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS)]: toWord(owner),
  };
}

/**
 * An `Api` that answers reads from `storage`, or rejects every slot read with `failure`. Each pin takes a new best
 * block, and `blocks` collects the block of every read.
 */
function createFakeApi(storage: Storage, failure?: Error): { api: Api; blocks: string[] } {
  const blocks: string[] = [];
  let pins = 0;
  const api: Api = {
    whenReady: () => Promise.resolve(),
    withBestBlock: read => {
      pins += 1;
      return read(`0x${pins.toString(16)}`);
    },
    resolveTrieId: (contractAddress, atHash) => {
      blocks.push(atHash);
      return Promise.resolve(contractAddress in storage ? TRIE_ID : null);
    },
    readSlot: (contractAddress, slotKey, { atHash }) => {
      blocks.push(atHash);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      return Promise.resolve(storage[contractAddress]?.[slotKey] ?? null);
    },
    resolveTrieIds: () => Promise.resolve(new Map()),
    readSlots: (_contract, keys) => Promise.resolve(keys.map(() => null)),
    onStop: () => () => undefined,
    destroy: () => undefined,
  };
  return { api, blocks };
}

/** An address right-aligned in a storage word. */
function toWord(address: string): Uint8Array {
  const word = new Uint8Array(32);
  word.set(fromHex(address), 12);
  return word;
}

/** Solidity's `bytes32` of a short string: its ASCII, right-padded with zeros. */
function toBytes32(text: string): `0x${string}` {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(text));
  return toHex(bytes);
}
