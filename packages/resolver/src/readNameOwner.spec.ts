// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import { fromHex, toHex } from '@dotli/shared';
import type { Api } from './createRawApi.js';
import { readNameOwner } from './readNameOwner.js';
import { addToSlot, computeMappingSlot, computeNamehash } from './storageSlots.js';

type SlotRead = {
  contractAddress: string;
  slotKey: `0x${string}`;
  options: { atHash?: string; trieId?: Uint8Array } | undefined;
};

/** The words each contract holds, by slot key. */
type Storage = Record<string, Record<string, Uint8Array>>;

const dotns = getActiveServicesConfig().dotns;
const LABEL = 'browse';
const BLOCK_HASH = '0x0b';
const PROTOCOL_REGISTRY = '0xd19e3d0c97cf501125a04a97405e3e6592fa846e';
const REGISTRAR = '0x4f06e818ba3d987704fd91cf3d868e4b019106ab';
const NAME_HOLDER = '0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20';
const RECORD_OWNER = '0xa7a4507c2b40d34303a7b284adcabbe41162b060';
const RESOLVER = '0xee3883d7eb60ee9bcd7f3bcd8f2f05302a9cc035';

const node = computeNamehash(`${LABEL}.${dotns.TLD}`);
const recordOwnerSlot = computeMappingSlot(node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
const recordFlagsSlot = addToSlot(recordOwnerSlot, 1);
const protocolRegistrySlot: `0x${string}` = `0x${dotns.STORAGE_SLOTS.REGISTRY_PROTOCOL_REGISTRY.toString(16).padStart(64, '0')}`;
const registrarSlot = computeMappingSlot(toBytes32('registrar'), dotns.STORAGE_SLOTS.PROTOCOL_REGISTRY_ADDRESSES);
const tokenHolderSlot = computeMappingSlot(node, dotns.STORAGE_SLOTS.REGISTRAR_OWNERS);

describe('readNameOwner', () => {
  it('As a visitor of a name the Registrar holds, I see its token holder as the owner', async () => {
    // Given a record with no owner of its own, and the Registrar holding the name's token
    const { api } = createFakeApi(createRegistrarStorage());

    // When the owner is read
    const owner = await readNameOwner({ api, dotns, label: LABEL });

    // Then the token holder is the owner
    expect(owner).toBe(NAME_HOLDER);
  });

  it('As a visitor of a subname, I see the owner its record holds', async () => {
    // Given a record that holds its owner
    const storage = createRegistrarStorage();
    storage[dotns.DOTNS_REGISTRY] = {
      [recordOwnerSlot]: toWord(RECORD_OWNER),
      [recordFlagsSlot]: toRecordFlags(RESOLVER),
    };
    const { api, reads } = createFakeApi(storage);

    // When the owner is read
    const owner = await readNameOwner({ api, dotns, label: LABEL });

    // Then the record's owner is the owner, and only the registry was read
    expect(owner).toBe(RECORD_OWNER);
    expect(new Set(reads.map(({ contractAddress }) => contractAddress))).toEqual(new Set([dotns.DOTNS_REGISTRY]));
  });

  it.each([
    [
      'a name with no record',
      (storage: Storage) => {
        storage[dotns.DOTNS_REGISTRY] = {};
      },
    ],
    [
      'a name with no protocol registry',
      (storage: Storage) => {
        delete storage[dotns.DOTNS_REGISTRY]?.[protocolRegistrySlot];
      },
    ],
    [
      'a name with no Registrar',
      (storage: Storage) => {
        storage[PROTOCOL_REGISTRY] = {};
      },
    ],
    [
      'a token with no holder',
      (storage: Storage) => {
        storage[REGISTRAR] = {};
      },
    ],
    [
      'a token whose holder is the zero address',
      (storage: Storage) => {
        storage[REGISTRAR] = { [tokenHolderSlot]: new Uint8Array(32) };
      },
    ],
  ])('As a visitor of %s, I see no owner', async (_case, clear) => {
    // Given the Registrar's storage with one link of the chain missing
    const storage = createRegistrarStorage();
    clear(storage);
    const { api } = createFakeApi(storage);

    // When the owner is read
    const owner = await readNameOwner({ api, dotns, label: LABEL });

    // Then the name has no owner
    expect(owner).toBeNull();
  });

  it('As a visitor, I see the owner read fail when a slot read fails', async () => {
    // Given storage whose every slot read rejects
    const failure = new Error('storage read failed');
    const { api } = createFakeApi(createRegistrarStorage(), failure);

    // When the owner is read
    const owner = readNameOwner({ api, dotns, label: LABEL });

    // Then the read rejects with the slot read failure
    await expect(owner).rejects.toBe(failure);
  });

  it('As a visitor, I read every slot of one name at one block', async () => {
    // Given a name the Registrar holds
    const { api, reads } = createFakeApi(createRegistrarStorage());

    // When the owner is read
    await readNameOwner({ api, dotns, label: LABEL });

    // Then every slot read is pinned to the same block
    expect(reads.map(({ options }) => options)).toEqual(Array(5).fill({ atHash: BLOCK_HASH }));
  });
});

/** The storage of a second-level name: an empty owner word, the `exists` flag, and the Registrar holding its token. */
function createRegistrarStorage(): Storage {
  return {
    [dotns.DOTNS_REGISTRY]: {
      [recordFlagsSlot]: toRecordFlags(RESOLVER),
      [protocolRegistrySlot]: toWord(PROTOCOL_REGISTRY),
    },
    [PROTOCOL_REGISTRY]: { [registrarSlot]: toWord(REGISTRAR) },
    [REGISTRAR]: { [tokenHolderSlot]: toWord(NAME_HOLDER) },
  };
}

/** An `Api` that answers slot reads from `storage` at `BLOCK_HASH`, or rejects every read with `failure`. */
function createFakeApi(storage: Storage, failure?: Error): { api: Api; reads: SlotRead[] } {
  const reads: SlotRead[] = [];
  const api: Api = {
    whenReady: () => Promise.resolve(),
    withBestBlock: read => read(BLOCK_HASH),
    resolveTrieId: () => Promise.reject(new Error('The owner read resolved a trie id of its own')),
    readSlot: (contractAddress, slotKey, options) => {
      reads.push({ contractAddress, slotKey, options });
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      return Promise.resolve(storage[contractAddress]?.[slotKey] ?? null);
    },
    onStop: () => () => undefined,
    destroy: () => undefined,
  };
  return { api, reads };
}

/** An address right-aligned in a storage word. */
function toWord(address: string): Uint8Array {
  const word = new Uint8Array(32);
  word.set(fromHex(address), 12);
  return word;
}

/** A record's second word: the resolver in its low 20 bytes and the `exists` flag in the byte above them. */
function toRecordFlags(resolver: string): Uint8Array {
  const word = toWord(resolver);
  word[11] = 1;
  return word;
}

/** Solidity's `bytes32` of a short string: its ASCII, right-padded with zeros. */
function toBytes32(text: string): `0x${string}` {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(text));
  return toHex(bytes);
}
