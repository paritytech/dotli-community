// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { clampPanelSize, clampSplit, keyDelta, panelSizeBounds, splitBounds, stepPanelSize } from './resize-clamp.js';

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

  it('As a keyboard user of the debug panel, I move a divider 16px with an arrow and 64px with Shift, along its own axis', () => {
    // Given a divider of each orientation

    // When
    const moves = [
      keyDelta('ArrowUp', 'horizontal', false),
      keyDelta('ArrowDown', 'horizontal', true),
      keyDelta('ArrowLeft', 'vertical', true),
      keyDelta('ArrowRight', 'vertical', false),
    ];

    // Then
    expect(moves).toEqual([-16, 64, -64, 16]);
  });

  it('As a keyboard user of the debug panel, I keep Tab, Enter, letters and the cross-axis arrows for the page', () => {
    // Given a divider that runs across the panel

    // When
    const others = ['Tab', 'Enter', 'a', 'ArrowLeft', 'ArrowRight'].map(key => keyDelta(key, 'horizontal', false));

    // Then
    expect(others).toEqual([null, null, null, null, null]);
  });

  it('As a keyboard user of the debug panel, I keep Alt, Ctrl and Cmd with an arrow for the browser history', () => {
    // Given an arrow pressed with a browser shortcut modifier held

    // When
    const move = keyDelta('ArrowLeft', 'vertical', false, true);

    // Then
    expect(move).toBeNull();
  });

  it('As a keyboard user of the debug panel, I grow and shrink the docked panel only within the bounds a drag keeps to', () => {
    // Given a bottom-docked panel 360px tall

    // When
    const sizes = [
      stepPanelSize('bottom', 360, 16, VIEWPORT),
      stepPanelSize('bottom', 130, -64, VIEWPORT),
      stepPanelSize('right', 800, 64, VIEWPORT),
    ];

    // Then
    expect(sizes.slice(0, 2)).toEqual([376, 120]);
    expect(sizes[2]).toBeCloseTo(819.2);
    const bounds = panelSizeBounds('bottom', VIEWPORT);
    expect(bounds.min).toBe(120);
    expect(bounds.max).toBeCloseTo(614.4);
  });

  it('As a keyboard user of the debug panel, I see the splitter bounds a drag keeps to', () => {
    // Given a body 1000px wide, and one too narrow for both minimums

    // When
    const bounds = [splitBounds(1000), splitBounds(300)];

    // Then
    expect(bounds).toEqual([
      { min: 220, max: 734 },
      { min: 220, max: 220 },
    ]);
  });
});
