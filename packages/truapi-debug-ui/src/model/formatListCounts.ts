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

/** The list's counts line in parts, each a phrase the line joins with a space. */
export type ListCounts = {
  total: string;
  /** Only when the ring evicted events. */
  dropped: string | null;
  /** Only when the filters hide events. */
  shown: string | null;
};

/** The list's counts line, naming evicted events and the filtered count only when there are any. Never throws. */
export function formatListCounts({ total, dropped, shown }: Params): ListCounts {
  return {
    total: formatEventCount(total),
    dropped: dropped > 0 ? `(+${String(dropped)} dropped)` : null,
    shown: shown !== total ? `· ${String(shown)} shown` : null,
  };
}
