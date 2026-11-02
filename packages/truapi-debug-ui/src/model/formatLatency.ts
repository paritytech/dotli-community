// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A duration as `<1ms`, whole ms below a second, or seconds to two places. Never throws. */
export function formatLatency(duration: number): string {
  if (duration < 1) {
    return '<1ms';
  }
  if (duration < 1000) {
    return `${String(Math.round(duration))}ms`;
  }
  return `${(duration / 1000).toFixed(2)}s`;
}
