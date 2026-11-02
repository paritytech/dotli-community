// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Whether `value` is a byte array, including one made in another realm. Never throws. */
export function isUint8ArrayLike(value: unknown): value is Uint8Array {
  if (value instanceof Uint8Array) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // `object` does not model a null-prototype object, which has no constructor.
  return (value as { constructor?: { name?: string } }).constructor?.name === 'Uint8Array';
}
