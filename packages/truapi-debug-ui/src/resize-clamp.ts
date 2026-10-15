// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bounds a drag or a key press of the panel's edge or its body splitter keeps to.

import type { DockPosition } from './model/dock-storage.js';

/** Room for the filter chips and tabs. */
const MIN_PRIMARY_PX = 220;
/** Room for the detail key-value list. */
const MIN_SECONDARY_PX = 260;
/** Matches the grid-template-{columns,rows} middle track. */
const SPLITTER_PX = 6;
const MIN_BOTTOM_HEIGHT_PX = 120;
const MIN_RIGHT_WIDTH_PX = 280;
const MAX_VIEWPORT_SHARE = 0.8;

/** A divider's pane size and the bounds it keeps to, in px. */
export interface DividerSize {
  now: number;
  min: number;
  max: number;
}

/** How far one arrow press moves a divider, and with Shift held. */
export const KEY_STEP_PX = 16;
export const KEY_STEP_LARGE_PX = 64;

function clampTo(size: number, bounds: { min: number; max: number }): number {
  return Math.max(bounds.min, Math.min(size, bounds.max));
}

/** The docked panel's size bounds along its drag axis. */
export function panelSizeBounds(
  dock: DockPosition,
  viewport: { width: number; height: number },
): { min: number; max: number } {
  return dock === 'right'
    ? { min: MIN_RIGHT_WIDTH_PX, max: viewport.width * MAX_VIEWPORT_SHARE }
    : { min: MIN_BOTTOM_HEIGHT_PX, max: viewport.height * MAX_VIEWPORT_SHARE };
}

/** The panel's size along the drag axis for the pointer, between the dock's minimum and most of the viewport. */
export function clampPanelSize(
  dock: DockPosition,
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
): number {
  const size = dock === 'right' ? viewport.width - pointer.x : viewport.height - pointer.y;
  return clampTo(size, panelSizeBounds(dock, viewport));
}

/** The panel's size after a key grows it by `grow` px (negative shrinks), kept to the same bounds as a drag. */
export function stepPanelSize(
  dock: DockPosition,
  size: number,
  grow: number,
  viewport: { width: number; height: number },
): number {
  return clampTo(size + grow, panelSizeBounds(dock, viewport));
}

/** The first pane's bounds in a body `span` px long, leaving the second pane its minimum. */
export function splitBounds(span: number): { min: number; max: number } {
  return { min: MIN_PRIMARY_PX, max: Math.max(MIN_PRIMARY_PX, span - MIN_SECONDARY_PX - SPLITTER_PX) };
}

/** The first pane's size for a pointer `offset` px into a body `span` px long, leaving both panes their minimum. */
export function clampSplit(offset: number, span: number): number {
  return clampTo(offset, splitBounds(span));
}

/**
 * How far a key moves a divider along the screen axis, right or down positive, or `null` for a key the divider leaves to
 * the page. A divider that runs across the panel moves up and down, one that runs along it left and right. With
 * `modified` (Alt, Ctrl or Meta held) every key is left to the browser, whose back and forward shortcuts use the arrows.
 */
export function keyDelta(
  key: string,
  orientation: 'horizontal' | 'vertical',
  large: boolean,
  modified = false,
): number | null {
  if (modified) {
    return null;
  }
  const step = large ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
  const [back, forward] = orientation === 'horizontal' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  if (key === back) {
    return -step;
  }
  if (key === forward) {
    return step;
  }
  return null;
}
