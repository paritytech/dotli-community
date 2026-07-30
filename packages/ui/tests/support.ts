// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared fixtures and helpers for the ui test suites.

export const genesisHash = `0x${"11".repeat(32)}` as const;
export const blockHash = `0x${"22".repeat(32)}` as const;

export function unwrap<T>(result: {
  isErr(): boolean;
  value: T;
  error: unknown;
}): T {
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
}
