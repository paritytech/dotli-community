// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { clampTo } from './clampTo.js';
import { getPanelSizeBounds } from './getPanelSizeBounds.js';
import type { DockPosition } from './model/createDockStorage.js';

type Params = {
  dock: DockPosition;
  pointer: { x: number; y: number };
  viewport: { width: number; height: number };
};

/**
 * The panel's size along the drag axis for the pointer, between the dock's minimum and most of the viewport. Never
 * throws.
 */
export function clampPanelSize({ dock, pointer, viewport }: Params): number {
  const fromEnd = { x: viewport.width - pointer.x, y: viewport.height - pointer.y };
  return clampTo(pickDragAxis(dock, fromEnd), getPanelSizeBounds(dock, viewport));
}

function pickDragAxis(dock: DockPosition, point: { x: number; y: number }): number {
  switch (dock) {
    case 'right':
      return point.x;
    case 'bottom':
      return point.y;
  }
}
