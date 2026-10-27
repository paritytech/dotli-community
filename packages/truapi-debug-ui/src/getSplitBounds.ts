// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Room for the filter chips and tabs. */
const MIN_PRIMARY_PX = 220;
/** Room for the detail key-value list. */
const MIN_SECONDARY_PX = 260;
/** The splitter's width, in px. */
const SPLITTER_PX = 6;

/** The first pane's bounds in a body `span` px long, leaving the second pane its minimum. Never throws. */
export function getSplitBounds(span: number): { min: number; max: number } {
  return { min: MIN_PRIMARY_PX, max: Math.max(MIN_PRIMARY_PX, span - MIN_SECONDARY_PX - SPLITTER_PX) };
}
