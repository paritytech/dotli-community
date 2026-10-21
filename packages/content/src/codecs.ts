// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The multicodec codes content reads from a CID. Constants only, so the entry chunk can take them without the hashing.

/** A CID codec: a UnixFS node. */
export const DAG_PB = 0x70;
/** A CID codec: the bytes themselves. */
export const RAW = 0x55;

/** A multihash code: what IPFS uses by default. */
export const SHA2_256 = 0x12;
/** A multihash code: what the Bulletin Chain and preimages use. */
export const BLAKE2B_256 = 0xb220;
