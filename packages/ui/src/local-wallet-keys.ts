// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// RFC-0022 sr25519 keys of the local wallet, derived in the page from the entropy it already holds, as the core
// derives them: the BIP-39 mini secret, hard `//junction` steps, and one soft step carrying a 32-byte derivation
// index. Only the experimental wallet's identity proofs and read-only allowance lookups use them.

import { blake2b } from '@noble/hashes/blake2.js';
import { entropyToMiniSecret } from '@polkadot-labs/hdkd-helpers';
import { getPublicKey, HDKD, secretFromSeed } from '@scure/sr25519';

export interface Sr25519Pair {
  /** 64-byte expanded secret. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

const CHAIN_CODE_BYTES = 32;
const PRODUCT_JUNCTION = 'product';
const IDENTITY_LABEL = 'uid';
const INDEX_MAGIC = blake2b(new TextEncoder().encode('product-account-index'), { dkLen: 32 }).subarray(0, 28);

function pair(secretKey: Uint8Array): Sr25519Pair {
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

function compactLength(length: number): Uint8Array {
  if (length < 1 << 6) {
    return Uint8Array.of(length << 2);
  }
  if (length < 1 << 14) {
    return Uint8Array.of(((length << 2) | 0b01) & 0xff, length >> 6);
  }
  throw new Error('Derivation junction is too long');
}

/** A junction's chain code: its SCALE encoding (a `u64` when all digits), zero-padded, or hashed past 32 bytes. */
export function junctionChainCode(junction: string): Uint8Array {
  let encoded: Uint8Array;
  if (/^\d+$/.test(junction)) {
    const value = BigInt(junction);
    if (value > 0xffff_ffff_ffff_ffffn) {
      throw new Error('Numeric derivation junction is outside u64 range');
    }
    encoded = new Uint8Array(8);
    new DataView(encoded.buffer).setBigUint64(0, value, true);
  } else {
    const bytes = new TextEncoder().encode(junction);
    encoded = new Uint8Array([...compactLength(bytes.length), ...bytes]);
  }
  if (encoded.length > CHAIN_CODE_BYTES) {
    return blake2b(encoded, { dkLen: CHAIN_CODE_BYTES });
  }
  const code = new Uint8Array(CHAIN_CODE_BYTES);
  code.set(encoded);
  return code;
}

/** The RFC-0022 32-byte derivation index of a plain `u32` index: little-endian, then the index magic. */
export function indexBytes(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`Invalid derivation index: ${String(index)}`);
  }
  const bytes = new Uint8Array(CHAIN_CODE_BYTES);
  new DataView(bytes.buffer).setUint32(0, index, true);
  bytes.set(INDEX_MAGIC, 4);
  return bytes;
}

export function rootKeypair(entropy: Uint8Array): Sr25519Pair {
  return pair(secretFromSeed(entropyToMiniSecret(entropy)));
}

/** `//j1//j2…` from the root key. */
export function deriveHardPath(entropy: Uint8Array, junctions: readonly string[]): Sr25519Pair {
  let secret = rootKeypair(entropy).secretKey;
  for (const junction of junctions) {
    secret = HDKD.secretHard(secret, junctionChainCode(junction));
  }
  return pair(secret);
}

/** `//product//{productId}/index`, the product account a core hands the product. */
export function productAccountKeypair(entropy: Uint8Array, productId: string, index = 0): Sr25519Pair {
  const subtree = deriveHardPath(entropy, [PRODUCT_JUNCTION, productId]);
  return pair(HDKD.secretSoft(subtree.secretKey, indexBytes(index)));
}

/** The network's public identity account, `uid.<suffix>` at index 0: the account usernames are recorded for. */
export function identityKeypair(entropy: Uint8Array, networkSuffix: string): Sr25519Pair {
  return productAccountKeypair(entropy, `${IDENTITY_LABEL}.${networkSuffix}`, 0);
}
