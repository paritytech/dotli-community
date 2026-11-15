// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatEventCount } from './formatEventCount.js';

type Params = {
  /** Events in the snapshot. */
  total: number;
  /** Events evicted from the ring buffer. */
  dropped: number;
  /** Events the filters let through. */
  shown: number;
};

/** The list's counts line, naming evicted events and the filtered count only when there are any. Never throws. */
export function formatListCounts({ total, dropped, shown }: Params): string {
  const totalLabel = dropped > 0 ? `${formatEventCount(total)} (+${String(dropped)} dropped)` : formatEventCount(total);
  const filterNote = shown !== total ? ` · ${String(shown)} shown` : '';
  return `${totalLabel}${filterNote}`;
}
