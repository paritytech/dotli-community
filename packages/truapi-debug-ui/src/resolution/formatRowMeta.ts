// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ResolutionRow } from '../model/buildResolution.js';
import { formatCount } from '../model/formatCount.js';

/** A chain row's peers, warp progress and database cache, joined by dots. Empty when none is known. Never throws. */
export function formatRowMeta(row: ResolutionRow): string {
  const parts: string[] = [];
  if (row.peers !== null) {
    parts.push(formatCount(row.peers, 'peer'));
  }
  if (row.warpAt !== null && row.warpTarget !== null) {
    parts.push(`warped to ${String(row.warpAt)} of ${String(row.warpTarget)}`);
  }
  if (row.dbCache !== null) {
    parts.push(`db ${row.dbCache}`);
  }
  return parts.join(' · ');
}
