// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS leaves the zero address as the Registry record's owner of a second-level name and keeps the real owner as the
// holder of the name's token in the Registrar. A subname's record holds its owner itself.

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { readProtocolAddress } from './readProtocolAddress.js';
import { addToSlot, computeMappingSlot, computeNamehash, decodeAddress } from './storageSlots.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  label: string;
};

/** Reads one slot of a contract at the block the owner read is pinned to. */
type ReadSlot = (contractAddress: string, slotKey: `0x${string}`) => Promise<Uint8Array | null>;

/** The record's `exists` flag sits in the byte just above the resolver address of its second word. */
const EXISTS_FLAG_BYTE = 11;

/**
 * Reads the address that owns a name in dotNS, in lowercase hex: the record's owner for a subname, else the holder of
 * the name's token in the Registrar. Resolves `null` when the name has no record, or a contract on the way or the token
 * holder is unset. Rejects with the error of the slot read that failed.
 */
export function readNameOwner({ api, dotns, label }: Params): Promise<string | null> {
  const node = computeNamehash(`${label}.${dotns.TLD}`);
  // One block for every slot, so a transfer between two reads cannot mix two states.
  return api.withBestBlock(async atHash => {
    const readSlot: ReadSlot = (contractAddress, slotKey) => api.readSlot(contractAddress, slotKey, { atHash });
    const record = await readRecord(readSlot, dotns, node);
    if (record.owner !== null) {
      return record.owner;
    }
    if (!record.exists) {
      return null;
    }
    const registrar = await readProtocolAddress({ api, dotns, atHash, contract: 'registrar' });
    if (registrar === null) {
      return null;
    }
    // The token id is the node read as a uint256, which keys the mapping with the same 32 bytes.
    return decodeAddress(await readSlot(registrar, computeMappingSlot(node, dotns.STORAGE_SLOTS.REGISTRAR_OWNERS)));
  });
}

/** What a name's Registry record says about its owner. */
async function readRecord(readSlot: ReadSlot, dotns: DotnsContracts, node: `0x${string}`) {
  const ownerSlot = computeMappingSlot(node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
  const [ownerWord, flagsWord] = await Promise.all([
    readSlot(dotns.DOTNS_REGISTRY, ownerSlot),
    readSlot(dotns.DOTNS_REGISTRY, addToSlot(ownerSlot, 1)),
  ]);
  return { owner: decodeAddress(ownerWord), exists: flagsWord?.[EXISTS_FLAG_BYTE] === 1 };
}
