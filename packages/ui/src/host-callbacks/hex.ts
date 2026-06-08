// Minimal hex utilities for generated TrUAPI wire types (`Uint8Array`)
// bridging to the `0x${string}` shape host-papp expects.
// Kept local so the UI package does not need host-api hex helpers.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type HexString = `0x${string}`;

export function toHexPrefixed(bytes: Uint8Array): HexString {
  return `0x${bytesToHex(bytes)}`;
}

export function fromHexPrefixed(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  return hexToBytes(stripped);
}
