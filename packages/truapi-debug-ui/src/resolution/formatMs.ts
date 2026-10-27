// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A duration in whole ms below a second, then seconds to two places below ten and one above. Never throws. */
export function formatMs(duration: number): string {
  if (duration < 1000) {
    return `${String(Math.round(duration))}ms`;
  }
  return `${(duration / 1000).toFixed(duration < 10_000 ? 2 : 1)}s`;
}
