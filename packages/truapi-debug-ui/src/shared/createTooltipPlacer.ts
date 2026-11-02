// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// When the hover tooltip must be measured, apart from its DOM wiring.

import { placeTooltip, type PanelBox, type TooltipPosition, type TooltipSize } from './placeTooltip.js';

/** The layout reads and writes a placement needs, each costly enough to skip when nothing changed. */
export type TooltipLayout<Target> = {
  /** The panel's box. Read before any write, so layout is clean. */
  readPanel: () => PanelBox;
  /** Puts `text` in the tooltip, styled for `element`, and shows it. */
  writeText: (text: string, element: Target) => void;
  /** The tooltip's size at the panel's left edge, since a prose tooltip near the right edge wraps narrow. */
  measure: () => TooltipSize;
};

type Params<Target> = {
  /** The element the tooltip is for. */
  element: Target;
  text: string;
  /** The tooltip is already showing. */
  shown: boolean;
  pointer: { x: number; y: number };
  viewportHeight: number;
};

/**
 * Places the tooltip for each pointer event. The panel box is read again only for a newly shown element, and the
 * tooltip is written and measured again only for new text, so a move over the shown element forces no layout. The
 * returned function never throws.
 */
export function createTooltipPlacer<Target>(layout: TooltipLayout<Target>) {
  let shownFor: Target | null = null;
  let shownText: string | null = null;
  let panel: PanelBox | null = null;
  let size: TooltipSize | null = null;
  return place;

  function place({ element, text, shown, pointer, viewportHeight }: Params<Target>): TooltipPosition {
    const fresh = element !== shownFor || panel === null || !shown;
    const box = fresh || panel === null ? layout.readPanel() : panel;
    if (fresh || text !== shownText) {
      layout.writeText(text, element);
      shownText = text;
      size = null;
    }
    panel = box;
    shownFor = element;
    size ??= layout.measure();
    return placeTooltip({ pointer, panel: box, size, viewportHeight });
  }
}
