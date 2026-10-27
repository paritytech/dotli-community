// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** `size` kept within `bounds`, the minimum winning when they cross. Never throws. */
export function clampTo(size: number, bounds: { min: number; max: number }): number {
  return Math.max(bounds.min, Math.min(size, bounds.max));
}
