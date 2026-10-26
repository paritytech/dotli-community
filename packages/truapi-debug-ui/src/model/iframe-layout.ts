// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import type { DockPosition } from './dock-storage.js';

const COLLAPSED_HEIGHT_PX = 32;

export type DockInsetInput = {
  collapsed: boolean;
  dock: DockPosition;
  width: number;
  height: number;
};

/** The px the panel covers along the frame's right and bottom edges. */
export function panelDockInset(input: DockInsetInput): {
  right: number;
  bottom: number;
} {
  if (input.dock === 'right') {
    // Collapsed, the header overlays the top-right corner instead of reserving a column.
    return { right: input.collapsed ? 0 : input.width, bottom: 0 };
  }
  return {
    right: 0,
    bottom: input.collapsed ? COLLAPSED_HEIGHT_PX : input.height,
  };
}
