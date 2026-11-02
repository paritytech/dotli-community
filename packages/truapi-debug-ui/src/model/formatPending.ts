// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** How long a call has waited, as whole ms below a second and tenths of a second above. Never throws. */
export function formatPending(duration: number): string {
  if (duration < 1000) {
    return `${String(Math.round(duration))}ms`;
  }
  return `${(duration / 1000).toFixed(1)}s`;
}
