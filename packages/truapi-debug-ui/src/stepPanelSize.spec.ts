// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { stepPanelSize } from './stepPanelSize.js';
import { VIEWPORT } from './testing/constants.js';

describe('debug panel resize keys', () => {
  it('As a keyboard user of the debug panel, I grow and shrink the docked panel and it stays within the bounds a drag keeps to', () => {
    // Given a bottom-docked panel 360px tall

    // When
    const sizes = [
      stepPanelSize({ dock: 'bottom', size: 360, grow: 16, viewport: VIEWPORT }),
      stepPanelSize({ dock: 'bottom', size: 130, grow: -64, viewport: VIEWPORT }),
      stepPanelSize({ dock: 'right', size: 800, grow: 64, viewport: VIEWPORT }),
    ];

    // Then
    expect(sizes.slice(0, 2)).toEqual([376, 120]);
    expect(sizes[2]).toBeCloseTo(819.2);
  });
});
