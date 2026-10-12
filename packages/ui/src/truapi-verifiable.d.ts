// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Resolved by `@config/vite/truapi-signing-worker` to the published core's ring-VRF glue. Results are SCALE
// `Result`s: `0x00` then the value, or `0x01` then the error string.
declare module 'dotli:truapi-verifiable' {
  export default function init(options?: { module_or_path: BufferSource | URL | string }): Promise<unknown>;
  /** The ring member, the 32-byte Bandersnatch public key of `entropy`: `Result<[u8; 32], String>`. */
  export function member(entropy: Uint8Array): Uint8Array;
  /** A plain VRF signature over `message`: `Result<Vec<u8>, String>`. */
  export function sign(entropy: Uint8Array, message: Uint8Array): Uint8Array;
}
