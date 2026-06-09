// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li performance timing helpers.

export function dur(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

export function elapsed(t0: number): string {
  return `+${((performance.now() - t0) / 1000).toFixed(3)}s`;
}
