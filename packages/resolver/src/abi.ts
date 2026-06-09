// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// ABI helpers and Solidity storage key computation
//
// Provides ENS-style namehash and storage slot key computation for
// reading Solidity contract storage directly via ReviveApi.get_storage.

import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes as nobleHexToBytes,
} from "@noble/hashes/utils.js";
import {
  decode as decodeContentHash,
  getCodec,
} from "@ensdomains/content-hash";

/** Convert bytes to 0x-prefixed hex string. */
export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}`;
}

/** Convert 0x-prefixed hex string to bytes. */
function hexToBytes(hex: `0x${string}`): Uint8Array {
  return nobleHexToBytes(hex.slice(2));
}

/** Compute the ENS-style namehash of a dotted name. */
export function namehash(name: string): `0x${string}` {
  let node = new Uint8Array(32); // 0x00...00
  if (name === "") {
    return toHex(node);
  }
  const labels = name.split(".").reverse();
  for (const label of labels) {
    const labelHash = keccak_256(new TextEncoder().encode(label));
    const combined = new Uint8Array(64);
    combined.set(node, 0);
    combined.set(labelHash, 32);
    node = new Uint8Array(keccak_256(combined));
  }
  return toHex(node);
}

// Solidity storage key computation.
//
// For a mapping(bytes32 => T) at storage slot N, the value
// for key K is stored at: keccak256(K ++ uint256(N))
//
// For bytes type (dynamic): if length <= 31, data is inline at
// the computed slot. If > 31, data starts at keccak256(slot).

/**
 * Compute the storage slot for a Solidity mapping entry.
 *
 * For `mapping(bytes32 => T)` at slot N, the value is at:
 *   keccak256(abi.encode(key, slot_number))
 *   = keccak256(key[32 bytes] ++ slot[32 bytes])
 */
export function computeMappingSlot(
  key: `0x${string}`,
  slotNumber: number,
): `0x${string}` {
  const slotBytes = new Uint8Array(32);
  let n = slotNumber;
  for (let i = 31; i >= 0 && n > 0; i--) {
    slotBytes[i] = n & 0xff;
    n >>>= 8;
  }

  return toHex(
    new Uint8Array(keccak_256(concatBytes(hexToBytes(key), slotBytes))),
  );
}

/**
 * Compute the data slot for long Solidity `bytes` storage.
 *
 * When bytes.length > 31, data starts at keccak256(baseSlot)
 * and spans consecutive slots.
 */
export function computeBytesDataSlot(baseSlot: `0x${string}`): `0x${string}` {
  return toHex(new Uint8Array(keccak_256(hexToBytes(baseSlot))));
}

/**
 * Compute the storage slot for a nested mapping with a string inner key.
 *
 * Used for `mapping(bytes32 outerKey => mapping(string innerKey => T))` at
 * outer slot N. The inner mapping lives at `keccak256(outerKey ++ N)`, both
 * padded to 32 bytes. The value sits at `keccak256(utf8(innerKey) ++ midSlot)`.
 *
 * Solidity hashes string keys as raw UTF-8 bytes with no length prefix and
 * no padding, which is why this helper exists alongside `computeMappingSlot`
 * (which expects a fixed-width key).
 */
export function computeNestedStringMappingSlot(
  outerKey: `0x${string}`,
  innerKey: string,
  outerSlot: number,
): `0x${string}` {
  const midSlot = computeMappingSlot(outerKey, outerSlot);
  const innerBytes = new TextEncoder().encode(innerKey);
  return toHex(
    new Uint8Array(keccak_256(concatBytes(innerBytes, hexToBytes(midSlot)))),
  );
}

/**
 * Add an offset to a storage slot key (for multi-slot values).
 *
 * Treats the 32-byte slot as a big-endian uint256 and adds the offset.
 */
export function addToSlot(slot: `0x${string}`, offset: number): `0x${string}` {
  if (offset === 0) {
    return slot;
  }
  const bytes = hexToBytes(slot);
  let carry = offset;
  for (let i = 31; i >= 0 && carry > 0; i--) {
    const sum = bytes[i] + (carry & 0xff);
    bytes[i] = sum & 0xff;
    carry = (carry >>> 8) + (sum >>> 8);
  }
  return toHex(bytes);
}

/**
 * Decode a 32-byte big-endian storage word as a bigint.
 */
export function wordToBigInt(data: Uint8Array): bigint {
  let value = 0n;
  for (const byte of data) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Extract an EVM address from a 32-byte storage word.
 * Address is right-aligned (last 20 bytes).
 */
export function extractAddress(data: Uint8Array): string {
  return `0x${bytesToHex(data.slice(12))}`;
}

/**
 * Read a Solidity `bytes` value from raw storage slot data.
 *
 * Short bytes (<= 31): data is inline, lowest byte = length * 2.
 * Long bytes (> 31): lowest bit is 1, full word = length * 2 + 1,
 * actual data at keccak256(baseSlot) spanning consecutive slots.
 *
 * Returns { inline: true, data } for short bytes,
 * or { inline: false, length, dataSlot } for long bytes
 * (caller must read the data slots).
 */
export function decodeBytesSlot(
  slotData: Uint8Array,
  baseSlotKey: `0x${string}`,
):
  | { inline: true; data: Uint8Array }
  | { inline: false; length: number; dataSlot: `0x${string}` }
  | null {
  if (slotData.every((b) => b === 0)) {
    return null;
  }

  const lowestByte = slotData[31];
  if ((lowestByte & 1) === 0) {
    // Short bytes: inline storage
    const length = lowestByte / 2;
    if (length === 0) {
      return null;
    }
    return { inline: true, data: slotData.slice(0, length) };
  }

  // Long bytes: length = (word - 1) / 2
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

/**
 * Discriminated result so callers can distinguish:
 *   - `empty`              : slot was unset (the name has no contenthash)
 *   - `unsupported-codec`  : record exists but isn't an IPFS contenthash
 *   - `decode-error`       : record exists but fails to decode (malformed)
 *   - `ok`                 : valid IPFS CID
 *
 * Returning `string | null` would collapse all four into "not found",
 * hiding real network decode failures behind the same UI message as
 * "no record set".
 */
export type ContenthashResult =
  | { kind: "ok"; cid: string }
  | { kind: "empty" }
  | { kind: "unsupported-codec"; codec: string | null }
  | { kind: "decode-error"; cause: unknown };

export function decodeIpfsContenthashResult(
  contenthashHex: string,
): ContenthashResult {
  const hex = contenthashHex.startsWith("0x")
    ? contenthashHex.slice(2)
    : contenthashHex;
  if (!hex || hex === "0" || hex.length < 4) {
    return { kind: "empty" };
  }
  let codec: string | null;
  try {
    codec = getCodec(hex) ?? null;
  } catch (cause) {
    return { kind: "decode-error", cause };
  }
  if (codec !== "ipfs") {
    return { kind: "unsupported-codec", codec };
  }
  try {
    const cid = decodeContentHash(hex);
    if (typeof cid === "string" && cid.length > 0) {
      return { kind: "ok", cid };
    }
    return {
      kind: "decode-error",
      cause: new Error("decodeContentHash returned empty"),
    };
  } catch (cause) {
    return { kind: "decode-error", cause };
  }
}

/**
 * Backwards-compatible string-or-null surface, for call sites that haven't
 * been migrated to the discriminated variant yet. New callers should use
 * `decodeIpfsContenthashResult` directly so they can surface the reason.
 */
export function decodeIpfsContenthash(contenthashHex: string): string | null {
  const result = decodeIpfsContenthashResult(contenthashHex);
  return result.kind === "ok" ? result.cid : null;
}
