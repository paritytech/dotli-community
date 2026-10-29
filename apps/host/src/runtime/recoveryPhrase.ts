// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { mnemonicToEntropy, validateMnemonic } from '@polkadot-labs/hdkd-helpers';

/**
 * The entropy of a valid English BIP-39 phrase, or null for anything else. Never throws. The checksum catches a single
 * mistyped word.
 */
export function toEntropy(phrase: string): Uint8Array | null {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  return validateMnemonic(normalized) ? mnemonicToEntropy(normalized) : null;
}
