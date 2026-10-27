// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** An `0x` value longer than 12 shown as its first 8 and last 4 characters around an ellipsis, any other value unchanged. Never throws. */
export function formatHexHeadAndTail(hex: string): string {
  if (hex.startsWith('0x') && hex.length > 12) {
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  }
  return hex;
}
