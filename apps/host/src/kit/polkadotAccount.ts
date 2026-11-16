// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Branded } from '@dotli/shared';

/** A Polkadot account as an SS58 address. */
export type PolkadotAccount = Branded<string, 'PolkadotAccount'>;

// SS58 is base58, whose alphabet leaves out 0, O, I and l.
const SS58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Parses a Polkadot account. Throws when `raw` is not an SS58 address. */
export function parsePolkadotAccount(raw: string): PolkadotAccount {
  if (!SS58_PATTERN.test(raw)) {
    throw new Error(`Account ${raw} is not an SS58 address`);
  }
  // The one place a plain string becomes a Polkadot account
  return raw as PolkadotAccount;
}
