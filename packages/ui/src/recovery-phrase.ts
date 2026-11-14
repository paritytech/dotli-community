// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@polkadot-labs/hdkd-helpers';

const RECOVERY_ENTROPY_BYTES = 32;

/** Generate a 24-word BIP-39 phrase from browser cryptographic randomness. */
export function createRecoveryPhrase(): string {
  return entropyToMnemonic(crypto.getRandomValues(new Uint8Array(RECOVERY_ENTROPY_BYTES)));
}

/** Null for anything that is not a valid English BIP-39 phrase. The checksum catches a single mistyped word. */
export function phraseToEntropy(phrase: string): Uint8Array | null {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  return validateMnemonic(normalized) ? mnemonicToEntropy(normalized) : null;
}
