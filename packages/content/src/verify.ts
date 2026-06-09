// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li content-addressing verification.
//
// A CID is the hash of its block's bytes, so recomputing that hash and
// comparing it to the CID turns an untrusted transport (a malicious or
// compromised IPFS gateway, or any MITM with a valid TLS cert for the
// gateway host) into a content-addressed one: substituted bytes no longer
// hash to the requested CID and are rejected.
//
// Used to wrap the gateway block source so every block in the fetched DAG
// is verified, to hash-check the raw-codec plain GET, and to spot-check the
// bitswap root block as defense-in-depth (see fetch.ts).

import { sha256 } from "@noble/hashes/sha2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { equals as bytesEqual } from "multiformats/bytes";
import type { CID } from "multiformats/cid";
import type { BlockSource } from "./archive";

// Multihash codes we can recompute. sha2-256 is IPFS's default; blake2b-256
// (0xb220) is what dot.li's bulletin/preimage path uses (see preimage.ts).
const SHA2_256 = 0x12;
const BLAKE2B_256 = 0xb220;

function recomputeDigest(multihashCode: number, bytes: Uint8Array): Uint8Array {
  switch (multihashCode) {
    case SHA2_256:
      return sha256(bytes);
    case BLAKE2B_256:
      return blake2b(bytes, { dkLen: 32 });
    default:
      // Fail closed: a hash we can't recompute is content we can't verify.
      throw new Error(
        `Cannot verify content: unsupported multihash code 0x${multihashCode.toString(16)}`,
      );
  }
}

/**
 * Assert that `bytes` is the content addressed by `cid`: recompute the
 * multihash digest and compare it to the CID's. Throws on mismatch, or on a
 * hash function we can't recompute (fail closed rather than serve
 * unverifiable bytes).
 */
export function assertBlockMatchesCid(cid: CID, bytes: Uint8Array): void {
  const expected = cid.multihash.digest;
  const actual = recomputeDigest(cid.multihash.code, bytes);
  if (!bytesEqual(actual, expected)) {
    throw new Error(
      `Content hash mismatch for ${cid.toString()} — refusing tampered content`,
    );
  }
}

/**
 * Wrap a {@link BlockSource} so every block it returns is hash-verified
 * against the requesting CID before the DAG walker sees it.
 */
export function verifyingBlockSource(source: BlockSource): BlockSource {
  return async (cid: CID): Promise<Uint8Array> => {
    const bytes = await source(cid);
    assertBlockMatchesCid(cid, bytes);
    return bytes;
  };
}

/**
 * Wrap a {@link BlockSource} so only the root block is hash-verified against
 * `rootCid` — defense-in-depth for a transport that already verifies interior
 * blocks (smoldot's bitswap), without re-hashing the whole DAG.
 */
export function rootVerifyingBlockSource(
  rootCid: CID,
  source: BlockSource,
): BlockSource {
  return async (cid: CID): Promise<Uint8Array> => {
    const bytes = await source(cid);
    if (cid.equals(rootCid)) {
      assertBlockMatchesCid(cid, bytes);
    }
    return bytes;
  };
}

/**
 * Assert that a CAR's declared root CID is the content we requested.
 * Compares codec + multihash (ignoring CIDv0/v1 framing) so an attacker
 * cannot serve a self-consistent CAR built around a root other than the
 * on-chain CID.
 */
export function assertSameContentId(actual: CID, expected: CID): void {
  if (
    actual.code !== expected.code ||
    !bytesEqual(actual.multihash.bytes, expected.multihash.bytes)
  ) {
    throw new Error(
      `CAR root ${actual.toString()} does not match requested ${expected.toString()}`,
    );
  }
}
