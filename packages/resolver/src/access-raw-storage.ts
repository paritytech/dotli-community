// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Solidity storage reads from a Revive contract. Multi-slot reads pin one block and the contract's
// `trie_id`, so a best-block change mid-loop cannot return bytes torn across two blocks.

import {
  computeMappingSlot,
  computeNestedStringMappingSlot,
  addToSlot,
  extractAddress,
  decodeBytesSlot,
} from './abi.js';
import { PartialStorageReadError } from './errors.js';
import type { Api } from './api.js';

export type StatusCallback = (status: string) => void;

/** Stable phase tokens. Status strings are for humans and change freely. */
export type ResolvePhase =
  | 'light-client-starting'
  | 'relay-chain-adding'
  | 'asset-hub-connecting'
  | 'asset-hub-syncing'
  | 'asset-hub-ready'
  | 'resolving-content';

export type PhaseCallback = (phase: ResolvePhase) => void;

/** Recovers the phase from a status string, for callers that only receive strings across a frame boundary. */
export function statusToPhase(message: string): ResolvePhase | null {
  if (message.startsWith('Starting light client')) {
    return 'light-client-starting';
  }
  if (message.startsWith('Adding Paseo relay')) {
    return 'relay-chain-adding';
  }
  if (message.startsWith('Connecting to Asset Hub') || message.includes('Discovering') || message.includes('peers')) {
    return 'asset-hub-connecting';
  }
  if (message.startsWith('Syncing with Asset Hub') || message.startsWith('Syncing #')) {
    return 'asset-hub-syncing';
  }
  if (message.startsWith('Synced to') || message.startsWith('Connected to Asset Hub')) {
    return 'asset-hub-ready';
  }
  if (message.includes('Resolving content')) {
    return 'resolving-content';
  }
  return null;
}

/** Keeps one block pinned until `read` settles. Resolves `null` without calling `read` when no contract exists. */
function withPinnedContract<T>(
  api: Api,
  contractAddress: string,
  read: (pin: { hash: string; trieId: Uint8Array }) => Promise<T | null>,
): Promise<T | null> {
  return api.withBestBlock(async hash => {
    const trieId = await api.resolveTrieId(contractAddress, hash);
    if (trieId === null) {
      return null;
    }
    return read({ hash, trieId });
  });
}

export function readMappingBytes(
  api: Api,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
): Promise<Uint8Array | null> {
  return withPinnedContract(api, contractAddress, pin =>
    readPinnedMappingBytes(api, contractAddress, mappingKey, mappingSlot, pin),
  );
}

async function readPinnedMappingBytes(
  api: Api,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
  pin: { hash: string; trieId: Uint8Array },
): Promise<Uint8Array | null> {
  const baseSlotKey = computeMappingSlot(mappingKey, mappingSlot);
  const baseData = await api.readSlot(contractAddress, baseSlotKey, pin.hash, pin.trieId);
  if (baseData === null) {
    return null;
  }
  const decoded = decodeBytesSlot(baseData, baseSlotKey);
  if (decoded === null) {
    return null;
  }
  if (decoded.inline) {
    return decoded.data;
  }
  const slotsNeeded = Math.ceil(decoded.length / 32);
  const result = new Uint8Array(decoded.length);
  for (let i = 0; i < slotsNeeded; i++) {
    const slotKey = addToSlot(decoded.dataSlot, i);
    const slotData = await api.readSlot(contractAddress, slotKey, pin.hash, pin.trieId);
    // Zero-padding the gap would yield a corrupt contenthash that reads as "name not found".
    if (slotData === null) {
      throw new PartialStorageReadError(contractAddress, i, slotsNeeded, {
        mappingKind: 'mapping bytes',
      });
    }
    const offset = i * 32;
    const copyLen = Math.min(32, decoded.length - offset);
    result.set(slotData.slice(0, copyLen), offset);
  }
  return result;
}

/** Reads a dotNS text record, keyed by namehash and then record name. Throws when a read stops partway. */
export function readNestedMappingString(
  api: Api,
  contractAddress: string,
  outerKey: `0x${string}`,
  innerKey: string,
  outerSlot: number,
): Promise<string | null> {
  return withPinnedContract(api, contractAddress, pin =>
    readPinnedNestedMappingString(api, contractAddress, outerKey, innerKey, outerSlot, pin),
  );
}

async function readPinnedNestedMappingString(
  api: Api,
  contractAddress: string,
  outerKey: `0x${string}`,
  innerKey: string,
  outerSlot: number,
  pin: { hash: string; trieId: Uint8Array },
): Promise<string | null> {
  const baseSlotKey = computeNestedStringMappingSlot(outerKey, innerKey, outerSlot);
  const baseData = await api.readSlot(contractAddress, baseSlotKey, pin.hash, pin.trieId);
  if (baseData === null) {
    return null;
  }
  const decoded = decodeBytesSlot(baseData, baseSlotKey);
  if (decoded === null) {
    return null;
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  if (decoded.inline) {
    return decoder.decode(decoded.data);
  }
  const slotsNeeded = Math.ceil(decoded.length / 32);
  const result = new Uint8Array(decoded.length);
  for (let i = 0; i < slotsNeeded; i++) {
    const slotKey = addToSlot(decoded.dataSlot, i);
    const slotData = await api.readSlot(contractAddress, slotKey, pin.hash, pin.trieId);
    if (slotData === null) {
      throw new PartialStorageReadError(contractAddress, i, slotsNeeded, {
        mappingKind: 'nested string mapping',
        innerKey,
      });
    }
    const offset = i * 32;
    const copyLen = Math.min(32, decoded.length - offset);
    result.set(slotData.slice(0, copyLen), offset);
  }
  return decoder.decode(result);
}

export async function readMappingAddress(
  api: Api,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
): Promise<string | null> {
  // A single slot cannot tear, so no pin.
  const slotKey = computeMappingSlot(mappingKey, mappingSlot);
  const data = await api.readSlot(contractAddress, slotKey);
  if (data === null) {
    return null;
  }
  const address = extractAddress(data);
  if (address === '0x0000000000000000000000000000000000000000') {
    return null;
  }
  return address;
}
