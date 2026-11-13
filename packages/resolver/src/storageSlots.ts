// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Solidity storage slot math, for reading contract storage directly instead of calling the contract.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { fromHex, toHex } from '@dotli/shared';

type ComputeNestedStringMappingSlotParams = {
  outerKey: `0x${string}`;
  innerKey: string;
  outerSlot: number;
};

/** ENS-style namehash. */
export function computeNamehash(name: string): `0x${string}` {
  let node = new Uint8Array(32);
  if (name === '') {
    return toHex(node);
  }
  const labels = name.split('.').reverse();
  for (const label of labels) {
    const labelHash = keccak_256(new TextEncoder().encode(label));
    const combined = new Uint8Array(64);
    combined.set(node, 0);
    combined.set(labelHash, 32);
    node = new Uint8Array(keccak_256(combined));
  }
  return toHex(node);
}

/**
 * For `mapping(bytes32 => T)` at slot N, key K lives at `keccak256(K ++ uint256(N))`. A namespaced contract gives its
 * slot as a 32-byte base slot, which is hashed in as it is. Throws when a hex base slot is not 32 bytes.
 */
export function computeMappingSlot(key: `0x${string}`, slot: number | `0x${string}`): `0x${string}` {
  const slotBytes = typeof slot === 'number' ? encodeSlotNumber(slot) : fromHex(slot);
  if (slotBytes.length !== 32) {
    throw new Error(`Storage base slot ${String(slot)} must be 32 bytes, got ${String(slotBytes.length)}`);
  }
  return toHex(new Uint8Array(keccak_256(concatBytes(fromHex(key), slotBytes))));
}

/** `bytes` longer than 31 start at `keccak256(baseSlot)` and span consecutive slots. */
function computeBytesDataSlot(baseSlot: `0x${string}`): `0x${string}` {
  return toHex(new Uint8Array(keccak_256(fromHex(baseSlot))));
}

/** For `mapping(bytes32 => mapping(string => T))`. Solidity hashes a string key as raw UTF-8, unpadded. */
export function computeNestedStringMappingSlot({
  outerKey,
  innerKey,
  outerSlot,
}: ComputeNestedStringMappingSlotParams): `0x${string}` {
  const midSlot = computeMappingSlot(outerKey, outerSlot);
  const innerBytes = new TextEncoder().encode(innerKey);
  return toHex(new Uint8Array(keccak_256(concatBytes(innerBytes, fromHex(midSlot)))));
}

/** Adds to the slot as a big-endian uint256. */
export function addToSlot(slot: `0x${string}`, offset: number): `0x${string}` {
  if (offset === 0) {
    return slot;
  }
  const bytes = fromHex(slot);
  let carry = offset;
  for (let index = 31; index >= 0 && carry > 0; index--) {
    const byte = bytes[index];
    if (byte === undefined) {
      throw new Error(`Storage slot must be 32 bytes, got ${String(bytes.length)}`);
    }
    const sum = byte + (carry & 0xff);
    bytes[index] = sum & 0xff;
    carry = (carry >>> 8) + (sum >>> 8);
  }
  return toHex(bytes);
}

/** Reads a storage word as a big-endian unsigned integer. */
export function readWordAsBigInt(data: Uint8Array): bigint {
  let value = 0n;
  for (const byte of data) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** The address is right-aligned in the word. */
export function extractAddress(data: Uint8Array): string {
  return toHex(data.slice(12));
}

/**
 * Short `bytes` sit inline with `length * 2` in the lowest byte. Long ones store `length * 2 + 1` and
 * leave the caller to read the data slots.
 */
export function decodeBytesSlot(
  slotData: Uint8Array,
  baseSlotKey: `0x${string}`,
): { inline: true; data: Uint8Array } | { inline: false; length: number; dataSlot: `0x${string}` } | null {
  if (slotData.every(b => b === 0)) {
    return null;
  }

  const lowestByte = slotData[31];
  if (lowestByte === undefined) {
    throw new Error(`Storage slot data must be 32 bytes, got ${String(slotData.length)}`);
  }
  if ((lowestByte & 1) === 0) {
    const length = lowestByte / 2;
    if (length === 0) {
      return null;
    }
    return { inline: true, data: slotData.slice(0, length) };
  }

  const word = readWordAsBigInt(slotData);
  const length = Number((word - 1n) / 2n);
  if (length === 0) {
    return null;
  }

  return {
    inline: false,
    length,
    dataSlot: computeBytesDataSlot(baseSlotKey),
  };
}

function encodeSlotNumber(slotNumber: number): Uint8Array {
  const slotBytes = new Uint8Array(32);
  let remaining = slotNumber;
  for (let index = 31; index >= 0 && remaining > 0; index--) {
    slotBytes[index] = remaining & 0xff;
    remaining >>>= 8;
  }
  return slotBytes;
}
