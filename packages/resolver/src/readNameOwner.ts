// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS leaves the zero address as the Registry record's owner of a second-level name and keeps the real owner as the
// holder of the name's token in the Registrar. A subname's record holds its owner itself.

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { addToSlot, computeMappingSlot, computeNamehash, extractAddress } from './storageSlots.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  label: string;
};

/** Reads one slot of a contract at the block the owner read is pinned to. */
type ReadSlot = (contractAddress: string, slotKey: `0x${string}`) => Promise<Uint8Array | null>;

type ReadRegistrarParams = {
  readSlot: ReadSlot;
  dotns: DotnsContracts;
};

type ReadRecordParams = {
  readSlot: ReadSlot;
  dotns: DotnsContracts;
  node: `0x${string}`;
};

type ReadTokenHolderParams = {
  readSlot: ReadSlot;
  dotns: DotnsContracts;
  node: `0x${string}`;
  registrar: string;
};

/** What a name's Registry record says about its owner. */
type NameRecord = {
  owner: string | null;
  exists: boolean;
};

const ZERO_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** The record's `exists` flag sits in the byte just above the resolver address of its second word. */
const EXISTS_FLAG_BYTE = 11;
/** `bytes32("registrar")`, the protocol registry's key for the Registrar: its ASCII, right-padded with zeros. */
const REGISTRAR_KEY = '0x7265676973747261720000000000000000000000000000000000000000000000';

/**
 * Reads the address that owns a name in dotNS, in lowercase hex: the record's owner for a subname, else the holder of
 * the name's token in the Registrar. Resolves `null` when the name has no record, or a contract on the way or the token
 * holder is unset. Rejects with the error of the slot read that failed.
 */
export function readNameOwner({ api, dotns, label }: Params): Promise<string | null> {
  const node = computeNamehash(`${label}.${dotns.TLD}`);
  // One block for every slot, so a transfer between two reads cannot mix two states.
  return api.withBestBlock(async hash => {
    const readSlot: ReadSlot = (contractAddress, slotKey) => api.readSlot(contractAddress, slotKey, { atHash: hash });
    const record = await readRecord({ readSlot, dotns, node });
    if (record.owner !== null) {
      return record.owner;
    }
    if (!record.exists) {
      return null;
    }
    const registrar = await readRegistrar({ readSlot, dotns });
    if (registrar === null) {
      return null;
    }
    return readTokenHolder({ readSlot, dotns, node, registrar });
  });
}

async function readRecord({ readSlot, dotns, node }: ReadRecordParams): Promise<NameRecord> {
  const ownerSlot = computeMappingSlot(node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
  const [ownerWord, flagsWord] = await Promise.all([
    readSlot(dotns.DOTNS_REGISTRY, ownerSlot),
    readSlot(dotns.DOTNS_REGISTRY, addToSlot(ownerSlot, 1)),
  ]);
  return { owner: toAddress(ownerWord), exists: flagsWord?.[EXISTS_FLAG_BYTE] === 1 };
}

async function readRegistrar({ readSlot, dotns }: ReadRegistrarParams): Promise<string | null> {
  const protocolRegistry = toAddress(
    await readSlot(dotns.DOTNS_REGISTRY, addToSlot(ZERO_SLOT, dotns.STORAGE_SLOTS.REGISTRY_PROTOCOL_REGISTRY)),
  );
  if (protocolRegistry === null) {
    return null;
  }
  const registrarSlot = computeMappingSlot(REGISTRAR_KEY, dotns.STORAGE_SLOTS.PROTOCOL_REGISTRY_ADDRESSES);
  return toAddress(await readSlot(protocolRegistry, registrarSlot));
}

async function readTokenHolder({ readSlot, dotns, node, registrar }: ReadTokenHolderParams): Promise<string | null> {
  // The token id is the node read as a uint256, which keys the mapping with the same 32 bytes.
  const holderSlot = computeMappingSlot(node, dotns.STORAGE_SLOTS.REGISTRAR_OWNERS);
  return toAddress(await readSlot(registrar, holderSlot));
}

/** An unset word and the zero address both mean no address. */
function toAddress(word: Uint8Array | null): string | null {
  if (word === null) {
    return null;
  }
  const address = extractAddress(word);
  if (address === ZERO_ADDRESS) {
    return null;
  }
  return address;
}
