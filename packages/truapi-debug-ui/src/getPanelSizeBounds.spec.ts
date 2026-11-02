// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getPanelSizeBounds } from './getPanelSizeBounds.js';

describe('debug panel size bounds', () => {
  it('As a keyboard user of the debug panel, I dock the panel at the bottom and its size keeps to the bounds a drag keeps to', () => {
    // When
    const bounds = getPanelSizeBounds('bottom', { width: 1024, height: 768 });

    // Then
    expect(bounds.min).toBe(120);
    expect(bounds.max).toBeCloseTo(614.4);
  });
});
