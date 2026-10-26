// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export type HexString = `0x${string}`;

/** The bytes as a `0x`-prefixed lowercase hex string. */
export function toHex(bytes: Uint8Array): HexString {
  return `0x${bytesToHex(bytes)}`;
}

/** The bytes a hex string encodes, with or without its `0x` prefix. Throws on an odd length or a non-hex digit. */
export function fromHex(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  return hexToBytes(stripped);
}
