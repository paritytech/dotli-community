// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { clampPanelSize, clampSplit } from './resize-clamp.js';

const VIEWPORT = { width: 1024, height: 768 };

describe('debug panel resize bounds', () => {
  it('As a dotli developer, dragging the top edge resizes the bottom-docked panel within 120px and 80% of the viewport', () => {
    // When the pointer is dragged to the middle, near the bottom and to the top
    const sizes = [500, 740, 0].map(y => clampPanelSize('bottom', { x: 0, y }, VIEWPORT));

    // Then
    expect(sizes.slice(0, 2)).toEqual([268, 120]);
    expect(sizes[2]).toBeCloseTo(614.4);
  });

  it('As a dotli developer, dragging the left edge resizes the right-docked panel within 280px and 80% of the viewport', () => {
    // When the pointer is dragged to the middle, near the right and to the left
    const sizes = [600, 1000, 0].map(x => clampPanelSize('right', { x, y: 0 }, VIEWPORT));

    // Then
    expect(sizes.slice(0, 2)).toEqual([424, 280]);
    expect(sizes[2]).toBeCloseTo(819.2);
  });

  it('As a dotli developer, the body splitter rebalances the panes within the documented minimums', () => {
    // Given a body 1000px wide
    const span = 1000;

    // When the splitter is dragged to the middle, near the left and near the right
    const sizes = [500, 40, 990].map(offset => clampSplit(offset, span));

    // Then the list keeps 220px and the detail keeps 260px plus the 6px splitter
    expect(sizes).toEqual([500, 220, 734]);
  });

  it('As a dotli developer, the body splitter resizes the top pane when docked right', () => {
    // Given a body 600px tall
    const span = 600;

    // When the splitter is dragged to the middle, near the top and past the bottom
    const sizes = [300, 10, 680].map(offset => clampSplit(offset, span));

    // Then
    expect(sizes).toEqual([300, 220, 334]);
  });
});
