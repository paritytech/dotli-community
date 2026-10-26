// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where the hover tooltip goes and when it must be measured, apart from its DOM wiring in hover-tooltip.ts.

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

/** Below and right of the pointer, pulled back inside the panel's right edge and flipped above near the viewport bottom. */
export function placeTooltip(
  pointer: { x: number; y: number },
  panel: PanelBox,
  size: TooltipSize,
  viewportHeight: number,
): TooltipPosition {
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

/** The layout reads and writes a placement needs, each costly enough to skip when nothing changed. */
export type TooltipLayout<E> = {
  /** The panel's box. Read before any write, so layout is clean. */
  readPanel: () => PanelBox;
  /** Puts `text` in the tooltip, styled for `el`, and shows it. */
  writeText: (text: string, el: E) => void;
  /** The tooltip's size at the panel's left edge, since a prose tooltip near the right edge wraps narrow. */
  measure: () => TooltipSize;
};

/**
 * Places the tooltip for each pointer event. The panel box is read again only for a newly shown element, and the
 * tooltip is written and measured again only for new text, so a move over the shown element forces no layout.
 */
export function createTooltipPlacer<E>(
  layout: TooltipLayout<E>,
): (el: E, text: string, shown: boolean, pointer: { x: number; y: number }, viewportHeight: number) => TooltipPosition {
  let shownFor: E | null = null;
  let shownText: string | null = null;
  let panel: PanelBox | null = null;
  let size: TooltipSize | null = null;
  return (el, text, shown, pointer, viewportHeight) => {
    const fresh = el !== shownFor || panel === null || !shown;
    const box = fresh || panel === null ? layout.readPanel() : panel;
    if (fresh || text !== shownText) {
      layout.writeText(text, el);
      shownText = text;
      size = null;
    }
    panel = box;
    shownFor = el;
    size ??= layout.measure();
    return placeTooltip(pointer, box, size, viewportHeight);
  };
}
