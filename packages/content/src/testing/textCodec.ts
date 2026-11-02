// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The UTF-8 bytes of a text. */
export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The text that UTF-8 bytes hold. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
