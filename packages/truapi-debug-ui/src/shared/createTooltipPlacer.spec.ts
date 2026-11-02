// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createTooltipPlacer, type TooltipLayout } from './createTooltipPlacer.js';

const PANEL = { left: 0, top: 0, right: 1000 };
const VIEWPORT_HEIGHT = 600;
/** A prose tooltip's natural width, which it has when measured at the panel's left edge. */
const NATURAL_WIDTH = 300;
const HEIGHT = 60;

/** A layout that counts its reads and writes. */
function createCountingLayout(): TooltipLayout<string> & { panelReads: number; writes: string[]; measures: number } {
  const writes: string[] = [];
  const layout = {
    panelReads: 0,
    writes,
    measures: 0,
    readPanel() {
      layout.panelReads += 1;
      return PANEL;
    },
    writeText(text: string) {
      writes.push(text);
    },
    measure() {
      layout.measures += 1;
      return { width: NATURAL_WIDTH, height: HEIGHT };
    },
  };
  return layout;
}

describe('hover tooltip placement', () => {
  it("As a dotli developer, I hover along the panel's right edge and a wrapped tooltip stays inside the panel", () => {
    // Given
    const place = createTooltipPlacer(createCountingLayout());

    // When shown near the right edge, then moved along it
    const shown = place({
      element: 'box',
      text: 'A long explanation',
      shown: false,
      pointer: { x: 900, y: 40 },
      viewportHeight: VIEWPORT_HEIGHT,
    });
    const moved = [901, 902, 903, 904, 905].map(x =>
      place({
        element: 'box',
        text: 'A long explanation',
        shown: true,
        pointer: { x, y: 40 },
        viewportHeight: VIEWPORT_HEIGHT,
      }),
    );

    // Then
    for (const at of [shown, ...moved]) {
      expect(at.left + NATURAL_WIDTH).toBeLessThanOrEqual(PANEL.right - 4);
    }
  });

  it('As a dotli developer, I move over the same tooltip after the clamp measured it and it is not measured or rewritten again', () => {
    // Given
    const layout = createCountingLayout();
    const place = createTooltipPlacer(layout);
    place({
      element: 'box',
      text: 'A long explanation',
      shown: false,
      pointer: { x: 900, y: 40 },
      viewportHeight: VIEWPORT_HEIGHT,
    });

    // When
    for (let x = 901; x <= 905; x++) {
      place({
        element: 'box',
        text: 'A long explanation',
        shown: true,
        pointer: { x, y: 40 },
        viewportHeight: VIEWPORT_HEIGHT,
      });
    }

    // Then
    expect(layout.panelReads).toBe(1);
    expect(layout.writes).toEqual(['A long explanation']);
    expect(layout.measures).toBe(1);
  });

  it('As a dotli developer, I hover while the tooltip text changes under the cursor and it is measured again', () => {
    // Given
    const layout = createCountingLayout();
    const place = createTooltipPlacer(layout);
    place({
      element: 'box',
      text: 'A long explanation',
      shown: false,
      pointer: { x: 100, y: 40 },
      viewportHeight: VIEWPORT_HEIGHT,
    });

    // When
    place({
      element: 'box',
      text: 'Another explanation',
      shown: true,
      pointer: { x: 101, y: 40 },
      viewportHeight: VIEWPORT_HEIGHT,
    });

    // Then
    expect(layout.writes).toEqual(['A long explanation', 'Another explanation']);
    expect(layout.measures).toBe(2);
    expect(layout.panelReads).toBe(1);
  });

  it('As a dotli developer, I hover another element and its tooltip reads the panel box again', () => {
    // Given
    const layout = createCountingLayout();
    const place = createTooltipPlacer(layout);
    place({
      element: 'first',
      text: 'Same text',
      shown: false,
      pointer: { x: 100, y: 40 },
      viewportHeight: VIEWPORT_HEIGHT,
    });

    // When
    place({
      element: 'second',
      text: 'Same text',
      shown: true,
      pointer: { x: 300, y: 40 },
      viewportHeight: VIEWPORT_HEIGHT,
    });

    // Then
    expect(layout.panelReads).toBe(2);
    expect(layout.measures).toBe(2);
  });
});
