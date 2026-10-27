// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type PanelBox = {
  left: number;
  top: number;
  right: number;
};

export type TooltipSize = {
  width: number;
  height: number;
};

/** Panel coordinates of the tooltip's top-left corner. */
export type TooltipPosition = {
  left: number;
  top: number;
};

type Params = {
  pointer: { x: number; y: number };
  panel: PanelBox;
  size: TooltipSize;
  viewportHeight: number;
};

/**
 * Below and right of the pointer, pulled back inside the panel's right edge and flipped above near the viewport bottom.
 * Never throws.
 */
export function placeTooltip({ pointer, panel, size, viewportHeight }: Params): TooltipPosition {
  let left = pointer.x - panel.left + 12;
  let top = pointer.y - panel.top + 16;
  const right = panel.left + left + size.width;
  const bottom = panel.top + top + size.height;
  if (right > panel.right - 4) {
    left = Math.max(4, left - (right - panel.right) - 6);
  }
  if (bottom > viewportHeight - 4) {
    top = top - size.height - 28;
  }
  return { left, top };
}
