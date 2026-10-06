// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li preimage CID utilities.
//
// Converts a preimage's Blake2b-256 hash to its CID for the preimage Host
// API's lookup (P2P/IPFS retrieval), and a Bulletin CID back to its key.

import { fromHex, toHex } from '@dotli/shared';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';

const BLAKE2B_256_MULTIHASH_CODE = 0xb220;
const RAW_CID_CODEC = 0x55;

/**
 * Convert a 0x-prefixed Blake2b-256 hash hex to a CID v1 (raw codec, 0xb220 multihash).
 */
export function hashToCid(hashHex: string): CID {
  const digest = create(BLAKE2B_256_MULTIHASH_CODE, fromHex(hashHex));
  return CID.createV1(RAW_CID_CODEC, digest);
}

/**
 * Inverse of `hashToCid`: the Blake2b-256 preimage key a Bulletin CID names.
 * Throws for any CID that is not CIDv1 raw with a Blake2b-256 multihash, the
 * only shape the preimage API content-addresses.
 */
export function cidToPreimageKey(cid: string): `0x${string}` {
  const parsed = CID.parse(cid);
  if (
    parsed.version !== 1 ||
    parsed.code !== RAW_CID_CODEC ||
    parsed.multihash.code !== BLAKE2B_256_MULTIHASH_CODE ||
    parsed.multihash.digest.length !== 32
  ) {
    throw new Error(`${cid} is not a raw Blake2b-256 CIDv1`);
  }
  return toHex(parsed.multihash.digest);
}
