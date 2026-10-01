// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How much of the product iframe the TrUAPI debug panel covers, so the host
// can keep the frame clear of it. The host's frame layout applies the insets;
// this module only computes them.
//
// Solid-free: consumed by the Solid truapi-debug components in
// `packages/ui/src/components/truapi-debug/`, so it must not import
// `@dotli/ui` or `solid-js`.

import type { DockPosition } from './dock-storage.js';

/** A collapsed panel is its 32px header bar. */
const COLLAPSED_HEIGHT_PX = 32;

export interface DockInsetInput {
  collapsed: boolean;
  dock: DockPosition;
  /** Panel's rendered width in px (e.g. `panel.offsetWidth`). Only consulted for the right dock. */
  width: number;
  /** Panel's rendered height in px (e.g. `panel.offsetHeight`). Only consulted for the bottom dock. */
  height: number;
}

/** The px the panel covers along the frame's right and bottom edges. */
export function panelDockInset(input: DockInsetInput): {
  right: number;
  bottom: number;
} {
  if (input.dock === 'right') {
    // When collapsed, the header bar overlays the top-right corner of the
    // frame rather than reserving a full-height column. Mirrors how the
    // bottom-dock collapse overlays only the bottom 32px.
    return { right: input.collapsed ? 0 : input.width, bottom: 0 };
  }
  return {
    right: 0,
    bottom: input.collapsed ? COLLAPSED_HEIGHT_PX : input.height,
  };
}
