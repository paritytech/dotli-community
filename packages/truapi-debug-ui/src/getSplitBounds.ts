// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Room for the filter chips and tabs. */
const MIN_PRIMARY_PX = 220;
/** Room for the detail key-value list. */
const MIN_SECONDARY_PX = 260;
/** The splitter's width, in px. */
const SPLITTER_PX = 6;

/**
 * The first pane's bounds in a body `span` px long, leaving the second pane its minimum. A body too short for both
 * minimums leaves each pane a third, so the detail never shrinks to nothing. Never throws.
 */
export function getSplitBounds(span: number): { min: number; max: number } {
  const panes = Math.max(0, span - SPLITTER_PX);
  if (panes >= MIN_PRIMARY_PX + MIN_SECONDARY_PX) {
    return { min: MIN_PRIMARY_PX, max: panes - MIN_SECONDARY_PX };
  }
  const third = Math.round(panes / 3);
  return { min: third, max: panes - third };
}
