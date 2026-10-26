// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { blake2b as nobleBlake2b } from '@noble/hashes/blake2.js';

/** The BLAKE2b digest of `data`, `outputBytes` long. */
export function blake2b(data: Uint8Array, outputBytes: number): Uint8Array {
  return nobleBlake2b(data, { dkLen: outputBytes });
}
