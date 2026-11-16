// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Returns the page's monotonic time in milliseconds, read at each call so a spec that fakes the globals still reaches
 * it. Never throws.
 */
export function readPageClock(): number {
  return performance.now();
}
