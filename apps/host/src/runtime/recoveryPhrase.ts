// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { mnemonicToEntropy, validateMnemonic } from '@polkadot-labs/hdkd-helpers';

/** Null for anything that is not a valid English BIP-39 phrase. The checksum catches a single mistyped word. */
export function phraseToEntropy(phrase: string): Uint8Array | null {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  return validateMnemonic(normalized) ? mnemonicToEntropy(normalized) : null;
}
