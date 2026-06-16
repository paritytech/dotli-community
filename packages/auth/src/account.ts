// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product account derivation for dot.li.
//
// Derives a product-specific public key from the user's root public key
// using HDKD soft derivation through junctions ['product', dotDomain, derivationIndex].
// Mirrors context__desktop/src/domains/product/account/service.ts

import { HDKD } from "@scure/sr25519";
import { blake2b } from "@noble/hashes/blake2.js";
import { AccountId } from "polkadot-api";
import { str, u64 } from "scale-ts";

const JUNCTION_ID_LEN = 32;
const NUMERIC_JUNCTION_RE = /^\d+$/;

const createChainCode = (code: string): Uint8Array => {
  const encoded = NUMERIC_JUNCTION_RE.test(code)
    ? u64.enc(BigInt(code))
    : str.enc(code);
  if (encoded.length > JUNCTION_ID_LEN) {
    return blake2b(encoded, { dkLen: JUNCTION_ID_LEN });
  }

  const chainCode = new Uint8Array(JUNCTION_ID_LEN);
  chainCode.set(encoded);
  return chainCode;
};

export const deriveProductPublicKey = (
  rootPublicKey: Uint8Array,
  productId: string,
  derivationIndex: number,
): Uint8Array => {
  const junctions = ["product", productId, String(derivationIndex)];

  return junctions.reduce((publicKey, junction) => {
    return HDKD.publicSoft(publicKey, createChainCode(junction));
  }, rootPublicKey);
};

const ss58Codec = AccountId();

/**
 * SS58-encode a 32-byte public key with the substrate-generic prefix (42).
 *
 * Matches the format the wallet uses when it hands a `signer` string back
 * to legacy-aware products, so byte-for-byte string comparison works for
 * `signPayloadWithLegacyAccount` and `signRawWithLegacyAccount` round-trips.
 */
export const productPublicKeyToAddress = (publicKey: Uint8Array): string =>
  ss58Codec.dec(publicKey);

/**
 * Inverse of `productPublicKeyToAddress`: decode an SS58 address string back to
 * its 32-byte public key. Used to turn a legacy account's `signer` address
 * (the wire format products send) into the `AccountId` bytes host-papp's
 * `signRawLegacy` expects. Throws on a malformed address.
 */
export const productAddressToPublicKey = (address: string): Uint8Array =>
  ss58Codec.enc(address);

// NOTE: Uncomment when derived product accounts get their own network
// allowance (quota) on People Chain. Currently only the root session account
// has allowance, so createProof signs with the root ssSecret directly.
// Once per-product allowance is supported, use this in handleStatementStoreCreateProof
// to sign with the product-derived key instead.
// export const deriveProductSecretKey = (
//   rootSecret: Uint8Array,
//   productId: string,
//   derivationIndex: number,
// ): Uint8Array => {
//   const junctions = ["product", productId, String(derivationIndex)];
//   return junctions.reduce((secret, junction) => {
//     return HDKD.secretSoft(secret, createChainCode(junction));
//   }, rootSecret);
// };
