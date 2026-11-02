// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { clampTo } from './clampTo.js';
import { getPanelSizeBounds } from './getPanelSizeBounds.js';
import type { DockPosition } from './model/createDockStorage.js';

/** A divider's pane size and the bounds it keeps to, in px. */
export type DividerSize = {
  now: number;
  min: number;
  max: number;
};

type Params = {
  dock: DockPosition;
  /** The panel's size along the dock axis now, in px. */
  size: number;
  /** The px the key adds, negative to shrink. */
  grow: number;
  viewport: { width: number; height: number };
};

/** The panel's size after a key grows it by `grow` px, kept to the same bounds as a drag. Never throws. */
export function stepPanelSize({ dock, size, grow, viewport }: Params): number {
  return clampTo(size + grow, getPanelSizeBounds(dock, viewport));
}
