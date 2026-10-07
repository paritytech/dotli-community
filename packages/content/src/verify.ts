// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Recomputing each block's hash against its CID makes an untrusted gateway content-addressed.

import { sha256 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { equals as bytesEqual } from 'multiformats/bytes';
import { CID } from 'multiformats/cid';
import { log } from '@dotli/shared';
import type { BlockSource } from './archive.js';
import { CONTENT_ERRORS, named } from './errors.js';

// IPFS defaults to sha2-256. The Bulletin chain and preimages use blake2b-256.
const SHA2_256 = 0x12;
const BLAKE2B_256 = 0xb220;

function recomputeDigest(multihashCode: number, bytes: Uint8Array): Uint8Array {
  switch (multihashCode) {
    case SHA2_256:
      return sha256(bytes);
    case BLAKE2B_256:
      return blake2b(bytes, { dkLen: 32 });
    default:
      // Fail closed, since a hash we cannot recompute is content we cannot verify.
      throw named(
        new Error(`Cannot verify content: unsupported multihash code 0x${multihashCode.toString(16)}`),
        CONTENT_ERRORS.VERIFICATION,
      );
  }
}

/** Throws on a mismatch, or on a hash function it cannot recompute. */
export function assertBlockMatchesCid(cid: CID, bytes: Uint8Array): void {
  const expected = cid.multihash.digest;
  const actual = recomputeDigest(cid.multihash.code, bytes);
  if (!bytesEqual(actual, expected)) {
    throw named(
      new Error(`Content hash mismatch for ${cid.toString()} — refusing tampered content`),
      CONTENT_ERRORS.VERIFICATION,
    );
  }
}

/** `false` also for an unparseable CID or a hash it cannot recompute. */
export function blockMatchesCid(cid: string, bytes: Uint8Array): boolean {
  try {
    assertBlockMatchesCid(CID.parse(cid), bytes);
    return true;
  } catch {
    return false;
  }
}

export function verifyingBlockSource(source: BlockSource): BlockSource {
  return async (cid: CID): Promise<Uint8Array> => {
    const bytes = await source(cid);
    assertBlockMatchesCid(cid, bytes);
    return bytes;
  };
}

/** Verifies only the root, for a transport that already verifies every block (smoldot bitswap). */
export function rootVerifyingBlockSource(rootCid: CID, source: BlockSource): BlockSource {
  return async (cid: CID): Promise<Uint8Array> => {
    const bytes = await source(cid);
    if (cid.equals(rootCid)) {
      assertBlockMatchesCid(cid, bytes);
      log.event(`Root block ${cid.toString()} verified`, { flow: 'content', bytes: bytes.length });
    }
    return bytes;
  };
}

/** Ignores CID version, so v0 and v1 of the same content match, while a self-consistent foreign CAR does not. */
export function assertSameContentId(actual: CID, expected: CID): void {
  if (actual.code !== expected.code || !bytesEqual(actual.multihash.bytes, expected.multihash.bytes)) {
    throw named(
      new Error(`CAR root ${actual.toString()} does not match requested ${expected.toString()}`),
      CONTENT_ERRORS.VERIFICATION,
    );
  }
}
