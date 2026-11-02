// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { clampPanelSize } from './clampPanelSize.js';
import { VIEWPORT } from './testing/constants.js';

describe('debug panel resize bounds', () => {
  it('As a dotli developer, I drag the top edge of the bottom-docked panel and it resizes within 120px and 80% of the viewport', () => {
    // When the pointer is dragged to the middle, near the bottom and to the top
    const sizes = [500, 740, 0].map(y => clampPanelSize({ dock: 'bottom', pointer: { x: 0, y }, viewport: VIEWPORT }));

    // Then
    expect(sizes.slice(0, 2)).toEqual([268, 120]);
    expect(sizes[2]).toBeCloseTo(614.4);
  });

  it('As a dotli developer, I drag the left edge of the right-docked panel and it resizes within 280px and 80% of the viewport', () => {
    // When the pointer is dragged to the middle, near the right and to the left
    const sizes = [600, 1000, 0].map(x => clampPanelSize({ dock: 'right', pointer: { x, y: 0 }, viewport: VIEWPORT }));

    // Then
    expect(sizes.slice(0, 2)).toEqual([424, 280]);
    expect(sizes[2]).toBeCloseTo(819.2);
  });
});
