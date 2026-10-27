// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so it runs under Node.

import type { DockPosition } from './createDockStorage.js';

type Params = {
  /** Folded to its header. */
  collapsed: boolean;
  dock: DockPosition;
  /** The panel's width in px, read only when docked right. */
  width: number;
  /** The panel's height in px, read only when docked at the bottom. */
  height: number;
};

const COLLAPSED_HEIGHT_PX = 32;

/** The px the panel covers along the frame's right and bottom edges. Never throws. */
export function getPanelDockInset({ collapsed, dock, width, height }: Params): {
  right: number;
  bottom: number;
} {
  switch (dock) {
    case 'right':
      // Collapsed, the header overlays the top-right corner instead of reserving a column.
      return { right: collapsed ? 0 : width, bottom: 0 };
    case 'bottom':
      return {
        right: 0,
        bottom: collapsed ? COLLAPSED_HEIGHT_PX : height,
      };
  }
}
