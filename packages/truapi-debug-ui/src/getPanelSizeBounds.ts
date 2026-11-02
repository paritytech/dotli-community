// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DockPosition } from './model/createDockStorage.js';

const MIN_BOTTOM_HEIGHT_PX = 120;
const MIN_RIGHT_WIDTH_PX = 280;
const MAX_VIEWPORT_SHARE = 0.8;

/** The docked panel's size bounds along its drag axis. Never throws. */
export function getPanelSizeBounds(
  dock: DockPosition,
  viewport: { width: number; height: number },
): { min: number; max: number } {
  switch (dock) {
    case 'right':
      return { min: MIN_RIGHT_WIDTH_PX, max: viewport.width * MAX_VIEWPORT_SHARE };
    case 'bottom':
      return { min: MIN_BOTTOM_HEIGHT_PX, max: viewport.height * MAX_VIEWPORT_SHARE };
  }
}
