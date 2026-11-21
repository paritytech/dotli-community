// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainSyncEvent } from '@dotli/chains';

/** The share of its warp sync a chain has proven, or null when the sample has no usable target. */
export function getWarpShare({ at, target }: ChainSyncEvent): number | null {
  if (at !== undefined && target !== undefined && target > 0 && at <= target) {
    return at / target;
  }
  return null;
}
