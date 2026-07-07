// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type HexString = `0x${string}`;

export function toHex(bytes: Uint8Array): HexString {
  return `0x${bytesToHex(bytes)}`;
}

export function fromHex(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  return hexToBytes(stripped);
}
