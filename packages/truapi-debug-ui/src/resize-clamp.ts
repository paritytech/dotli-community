// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bounds a drag of the panel's edge or its body splitter keeps to, apart from the drag wiring in Resizers.tsx.

import type { DockPosition } from '@dotli/truapi-debug';

/** Room for the filter chips and tabs. */
const MIN_PRIMARY_PX = 220;
/** Room for the detail key-value list. */
const MIN_SECONDARY_PX = 260;
/** Matches the grid-template-{columns,rows} middle track. */
const SPLITTER_PX = 6;
const MIN_BOTTOM_HEIGHT_PX = 120;
const MIN_RIGHT_WIDTH_PX = 280;
const MAX_VIEWPORT_SHARE = 0.8;

/** The panel's size along the drag axis for the pointer, between the dock's minimum and most of the viewport. */
export function clampPanelSize(
  dock: DockPosition,
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
): number {
  if (dock === 'right') {
    return Math.max(MIN_RIGHT_WIDTH_PX, Math.min(viewport.width - pointer.x, viewport.width * MAX_VIEWPORT_SHARE));
  }
  return Math.max(MIN_BOTTOM_HEIGHT_PX, Math.min(viewport.height - pointer.y, viewport.height * MAX_VIEWPORT_SHARE));
}

/** The first pane's size for a pointer `offset` px into a body `span` px long, leaving both panes their minimum. */
export function clampSplit(offset: number, span: number): number {
  const max = Math.max(MIN_PRIMARY_PX, span - MIN_SECONDARY_PX - SPLITTER_PX);
  return Math.max(MIN_PRIMARY_PX, Math.min(offset, max));
}
