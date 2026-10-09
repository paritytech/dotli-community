// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Solidity storage slot math, for reading contract storage directly instead of calling the contract.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';
import { decode as decodeContentHash, getCodec } from '@ensdomains/content-hash';

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}`;
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  return nobleHexToBytes(hex.slice(2));
}

/** ENS-style namehash. */
export function namehash(name: string): `0x${string}` {
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

/** For `mapping(bytes32 => T)` at slot N, key K lives at `keccak256(K ++ uint256(N))`. */
export function computeMappingSlot(key: `0x${string}`, slotNumber: number): `0x${string}` {
  const slotBytes = new Uint8Array(32);
  let n = slotNumber;
  for (let i = 31; i >= 0 && n > 0; i--) {
    slotBytes[i] = n & 0xff;
    n >>>= 8;
  }

  return toHex(new Uint8Array(keccak_256(concatBytes(hexToBytes(key), slotBytes))));
}

/** `bytes` longer than 31 start at `keccak256(baseSlot)` and span consecutive slots. */
export function computeBytesDataSlot(baseSlot: `0x${string}`): `0x${string}` {
  return toHex(new Uint8Array(keccak_256(hexToBytes(baseSlot))));
}

/** For `mapping(bytes32 => mapping(string => T))`. Solidity hashes a string key as raw UTF-8, unpadded. */
export function computeNestedStringMappingSlot(
  outerKey: `0x${string}`,
  innerKey: string,
  outerSlot: number,
): `0x${string}` {
  const midSlot = computeMappingSlot(outerKey, outerSlot);
  const innerBytes = new TextEncoder().encode(innerKey);
  return toHex(new Uint8Array(keccak_256(concatBytes(innerBytes, hexToBytes(midSlot)))));
}

/** Adds to the slot as a big-endian uint256. */
export function addToSlot(slot: `0x${string}`, offset: number): `0x${string}` {
  if (offset === 0) {
    return slot;
  }
  const bytes = hexToBytes(slot);
  let carry = offset;
  for (let i = 31; i >= 0 && carry > 0; i--) {
    const byte = bytes[i];
    if (byte === undefined) {
      throw new Error(`Storage slot must be 32 bytes, got ${String(bytes.length)}`);
    }
    const sum = byte + (carry & 0xff);
    bytes[i] = sum & 0xff;
    carry = (carry >>> 8) + (sum >>> 8);
  }
  return toHex(bytes);
}

export function wordToBigInt(data: Uint8Array): bigint {
  let value = 0n;
  for (const byte of data) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** The address is right-aligned in the word. */
export function extractAddress(data: Uint8Array): string {
  return `0x${bytesToHex(data.slice(12))}`;
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

  const word = wordToBigInt(slotData);
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

/** Discriminated, so a malformed record is not reported as an unset one. */
export type ContenthashResult =
  | { kind: 'ok'; cid: string }
  | { kind: 'empty' }
  | { kind: 'unsupported-codec'; codec: string | null }
  | { kind: 'decode-error'; cause: unknown };

export function decodeIpfsContenthashResult(contenthashHex: string): ContenthashResult {
  const hex = contenthashHex.startsWith('0x') ? contenthashHex.slice(2) : contenthashHex;
  if (!hex || hex === '0' || hex.length < 4) {
    return { kind: 'empty' };
  }
  let codec: string | null;
  try {
    codec = getCodec(hex) ?? null;
  } catch (cause) {
    return { kind: 'decode-error', cause };
  }
  if (codec !== 'ipfs') {
    return { kind: 'unsupported-codec', codec };
  }
  try {
    const cid = decodeContentHash(hex);
    if (typeof cid === 'string' && cid.length > 0) {
      return { kind: 'ok', cid };
    }
    return {
      kind: 'decode-error',
      cause: new Error('decodeContentHash returned empty'),
    };
  } catch (cause) {
    return { kind: 'decode-error', cause };
  }
}
