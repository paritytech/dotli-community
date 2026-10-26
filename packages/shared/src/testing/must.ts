// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The value, or a throw naming `what` was expected when it is `null` or `undefined`. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}, got ${String(value)}`);
  }
  return value;
}
