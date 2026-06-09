// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li preimage hash and CID utilities.
//
// Provides Blake2b-256 hash computation and CID conversion for
// the preimage Host API. Used by both submit (hash the data) and
// lookup (convert hash to CID for P2P/IPFS retrieval).

import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import { create } from "multiformats/hashes/digest";

const BLAKE2B_256_MULTIHASH_CODE = 0xb220;
const RAW_CID_CODEC = 0x55;

/**
 * Compute the Blake2b-256 hash of data, return as 0x-prefixed hex string.
 */
export function computePreimageKey(data: Uint8Array): `0x${string}` {
  const hash = blake2b(data, { dkLen: 32 });
  return `0x${Array.from(hash, (b: number) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Convert a 0x-prefixed Blake2b-256 hash hex to a CID v1 (raw codec, 0xb220 multihash).
 */
export function hashToCid(hashHex: string): CID {
  const hex = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;
  const hashBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hashBytes.length; i++) {
    hashBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const digest = create(BLAKE2B_256_MULTIHASH_CODE, hashBytes);
  return CID.createV1(RAW_CID_CODEC, digest);
}
