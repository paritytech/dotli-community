// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Branded } from '@dotli/shared';

/** An Asset Hub account address, 20 bytes as `0x` hex. */
export type H160Address = Branded<string, 'H160Address'>;

const H160_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Parses an Asset Hub account address. Throws when `raw` is not 20 bytes as `0x` hex. */
export function parseH160Address(raw: string): H160Address {
  if (!H160_PATTERN.test(raw)) {
    throw new Error(`Address ${raw} is not a 20-byte hex address`);
  }
  // The one place a plain string becomes an H160 address
  return raw as H160Address;
}
