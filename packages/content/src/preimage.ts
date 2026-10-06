// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li preimage CID utilities.
//
// Converts a preimage's Blake2b-256 hash to its CID for the preimage Host
// API's lookup (P2P/IPFS retrieval).

import { fromHex } from '@dotli/shared';
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
