// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A bigint as its digits and the `n` suffix. Never throws. */
export function formatBigInt(value: bigint): string {
  return `${value.toString()}n`;
}
