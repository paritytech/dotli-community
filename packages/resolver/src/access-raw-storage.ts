// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared contract storage reading utilities
//
// Low-level functions for reading Solidity storage slots from a Revive
// (EVM-on-Polkadot) contract via a `Api`. Both the smoldot and the
// trusted RPC resolvers use the same raw `chainHead_v1_storage` reader from
// `storage-api.ts`. Multi-slot reads pin both the chain-head hash and the
// contract's `trie_id` once at entry so that a `bestBlockChanged` mid-loop
// cannot return torn bytes spanning two blocks.

import {
  computeMappingSlot,
  computeNestedStringMappingSlot,
  addToSlot,
  extractAddress,
  decodeBytesSlot,
} from "./abi";
import { PartialStorageReadError } from "./errors";
import type { Api } from "./api";
import { ApiStoppedError } from "./api";

export type StatusCallback = (status: string) => void;

/**
 * Structured resolver phase events. Callers that want to advance a
 * multi-step loading indicator should listen to these instead of
 * parsing status strings with regex. The string formats are for
 * humans and change freely, and the phase tokens are a stable contract.
 */
export type ResolvePhase =
  | "light-client-starting"
  | "relay-chain-adding"
  | "asset-hub-connecting"
  | "asset-hub-syncing"
  | "asset-hub-ready"
  | "resolving-content";

export type PhaseCallback = (phase: ResolvePhase) => void;

/**
 * Map a human-readable resolver status string back to its `ResolvePhase`.
 *
 * The resolver itself now emits phase events directly via its `onPhase`
 * callback, but callers that bridge status across a worker/iframe
 * boundary (where a structured callback can't cross easily) can use
 * this helper to reconstruct the phase on the receiving side without
 * duplicating the regex in every consumer. Returns `null` for status
 * messages that don't map to a known phase.
 */
export function statusToPhase(message: string): ResolvePhase | null {
  if (message.startsWith("Starting light client")) {
    return "light-client-starting";
  }
  if (message.startsWith("Adding Paseo relay")) {
    return "relay-chain-adding";
  }
  if (
    message.startsWith("Connecting to Asset Hub") ||
    message.includes("Discovering") ||
    message.includes("peers")
  ) {
    return "asset-hub-connecting";
  }
  if (
    message.startsWith("Syncing with Asset Hub") ||
    message.startsWith("Syncing #")
  ) {
    return "asset-hub-syncing";
  }
  if (
    message.startsWith("Synced to") ||
    message.startsWith("Connected to Asset Hub")
  ) {
    return "asset-hub-ready";
  }
  if (message.includes("Resolving content")) {
    return "resolving-content";
  }
  return null;
}

/**
 * Pin a single block hash and the contract's `trie_id` for a logical
 * multi-slot read. Throws `ApiStoppedError` if the underlying follow
 * has died. Returns `null` if the contract doesn't exist (no AccountInfoOf
 * or wrong enum tag).
 */
async function pinContract(
  api: Api,
  contractAddress: string,
): Promise<{ hash: string; trieId: Uint8Array } | null> {
  const hash = api.bestHash();
  if (hash === null) {
    throw new ApiStoppedError();
  }
  const trieId = await api.resolveTrieId(contractAddress, hash);
  if (trieId === null) {
    return null;
  }
  return { hash, trieId };
}

export async function readStorageSlot(
  api: Api,
  contractAddress: string,
  slotKey: `0x${string}`,
): Promise<Uint8Array | null> {
  // Single-slot path. Multi-slot callers (`readMappingBytes`,
  // `readNestedMappingString`) pin hash and trie_id themselves via
  // `pinContract` and pass them through `readSlot` to avoid torn reads.
  return api.readSlot(contractAddress, slotKey);
}

export async function readMappingBytes(
  api: Api,
  contractAddress: string,
  mappingKey: `0x${string}`,
  mappingSlot: number,
): Promise<Uint8Array | null> {
  const pin = await pinContract(api, contractAddress);
  if (pin === null) {
    return null;
  }
  const baseSlotKey = computeMappingSlot(mappingKey, mappingSlot);
  const baseData = await api.readSlot(
    contractAddress,
    baseSlotKey,
    pin.hash,
    pin.trieId,
  );
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
    const slotData = await api.readSlot(
      contractAddress,
      slotKey,
      pin.hash,
      pin.trieId,
    );
    // If any slot read returns null mid-way, throw. Silently zero-padding
    // the gap would return a corrupted contenthash that reads upstream as
    // "name not found", masking the actual RPC failure.
    if (slotData === null) {
      throw new PartialStorageReadError(contractAddress, i, slotsNeeded, {
        mappingKind: "mapping bytes",
      });
    }
    const offset = i * 32;
    const copyLen = Math.min(32, decoded.length - offset);
    result.set(slotData.slice(0, copyLen), offset);
  }
  return result;
}

/**
 * Read a UTF-8 string value from `mapping(bytes32 => mapping(string => string))`.
 *
 * The dotNS content resolver stores text records under this shape. The outer
 * key is the namehash of the dotNS name, the inner key is the record name
 * such as `"manifest"` or `"executable"`.
 *
 * Returns `null` when the value is unset. Throws when a multi-slot read
 * aborts partway, mirroring [`readMappingBytes`](./storage.ts).
 */
export async function readNestedMappingString(
  api: Api,
  contractAddress: string,
  outerKey: `0x${string}`,
  innerKey: string,
  outerSlot: number,
): Promise<string | null> {
  const pin = await pinContract(api, contractAddress);
  if (pin === null) {
    return null;
  }
  const baseSlotKey = computeNestedStringMappingSlot(
    outerKey,
    innerKey,
    outerSlot,
  );
  const baseData = await api.readSlot(
    contractAddress,
    baseSlotKey,
    pin.hash,
    pin.trieId,
  );
  if (baseData === null) {
    return null;
  }
  const decoded = decodeBytesSlot(baseData, baseSlotKey);
  if (decoded === null) {
    return null;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  if (decoded.inline) {
    return decoder.decode(decoded.data);
  }
  const slotsNeeded = Math.ceil(decoded.length / 32);
  const result = new Uint8Array(decoded.length);
  for (let i = 0; i < slotsNeeded; i++) {
    const slotKey = addToSlot(decoded.dataSlot, i);
    const slotData = await api.readSlot(
      contractAddress,
      slotKey,
      pin.hash,
      pin.trieId,
    );
    if (slotData === null) {
      throw new PartialStorageReadError(contractAddress, i, slotsNeeded, {
        mappingKind: "nested string mapping",
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
  // Single-slot read, no torn-read risk so no need to pin.
  const slotKey = computeMappingSlot(mappingKey, mappingSlot);
  const data = await api.readSlot(contractAddress, slotKey);
  if (data === null) {
    return null;
  }
  const address = extractAddress(data);
  if (address === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return address;
}
