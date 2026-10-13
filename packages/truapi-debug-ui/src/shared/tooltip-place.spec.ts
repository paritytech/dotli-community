// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createTooltipPlacer, placeTooltip, type TooltipLayout } from './tooltip-place.js';

const PANEL = { left: 0, top: 0, right: 1000 };
const VIEWPORT_HEIGHT = 600;
/** A prose tooltip's natural width, which it has when measured at the panel's left edge. */
const NATURAL_WIDTH = 300;
const HEIGHT = 60;

/** A layout that counts its reads and writes. */
function countingLayout(): TooltipLayout<string> & { panelReads: number; writes: string[]; measures: number } {
  const layout = {
    panelReads: 0,
    writes: [] as string[],
    measures: 0,
    readPanel: () => {
      layout.panelReads += 1;
      return PANEL;
    },
    writeText: (text: string) => {
      layout.writes.push(text);
    },
    measure: () => {
      layout.measures += 1;
      return { width: NATURAL_WIDTH, height: HEIGHT };
    },
  };
  return layout;
}

describe('hover tooltip placement', () => {
  it("As a dotli developer hovering near the panel's right edge, a wrapped tooltip stays inside the panel", () => {
    // Given
    const place = createTooltipPlacer(countingLayout());

    // When shown near the right edge, then moved along it
    const shown = place('box', 'A long explanation', false, { x: 900, y: 40 }, VIEWPORT_HEIGHT);
    const moved = [901, 902, 903, 904, 905].map(x =>
      place('box', 'A long explanation', true, { x, y: 40 }, VIEWPORT_HEIGHT),
    );

    // Then
    for (const at of [shown, ...moved]) {
      expect(at.left + NATURAL_WIDTH).toBeLessThanOrEqual(PANEL.right - 4);
    }
  });

  it('As a dotli developer, moving over the same tooltip after the clamp measured it does not measure or rewrite again', () => {
    // Given
    const layout = countingLayout();
    const place = createTooltipPlacer(layout);
    place('box', 'A long explanation', false, { x: 900, y: 40 }, VIEWPORT_HEIGHT);

    // When
    for (let x = 901; x <= 905; x++) {
      place('box', 'A long explanation', true, { x, y: 40 }, VIEWPORT_HEIGHT);
    }

    // Then
    expect(layout.panelReads).toBe(1);
    expect(layout.writes).toEqual(['A long explanation']);
    expect(layout.measures).toBe(1);
  });

  it('As a dotli developer, a tooltip whose text changes under the cursor is measured again', () => {
    // Given
    const layout = countingLayout();
    const place = createTooltipPlacer(layout);
    place('box', 'A long explanation', false, { x: 100, y: 40 }, VIEWPORT_HEIGHT);

    // When
    place('box', 'Another explanation', true, { x: 101, y: 40 }, VIEWPORT_HEIGHT);

    // Then
    expect(layout.writes).toEqual(['A long explanation', 'Another explanation']);
    expect(layout.measures).toBe(2);
    expect(layout.panelReads).toBe(1);
  });

  it('As a dotli developer, a tooltip shown for another element reads the panel box again', () => {
    // Given
    const layout = countingLayout();
    const place = createTooltipPlacer(layout);
    place('first', 'Same text', false, { x: 100, y: 40 }, VIEWPORT_HEIGHT);

    // When
    place('second', 'Same text', true, { x: 300, y: 40 }, VIEWPORT_HEIGHT);

    // Then
    expect(layout.panelReads).toBe(2);
    expect(layout.measures).toBe(2);
  });

  it('As a dotli developer hovering near the bottom of the screen, the tooltip flips above the pointer', () => {
    // When
    const at = placeTooltip({ x: 100, y: 560 }, PANEL, { width: 200, height: HEIGHT }, VIEWPORT_HEIGHT);

    // Then
    expect(at).toEqual({ left: 112, top: 560 + 16 - HEIGHT - 28 });
  });
});
