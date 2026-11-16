// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Throws when a protocol field that must name something is empty. */
export function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}
