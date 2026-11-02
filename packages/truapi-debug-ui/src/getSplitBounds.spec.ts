// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getSplitBounds } from './getSplitBounds.js';

describe('debug panel splitter bounds', () => {
  it('As a keyboard user of the debug panel, I move the splitter and it keeps to the bounds a drag keeps to', () => {
    // Given a body 1000px wide, and one too narrow for both minimums

    // When
    const bounds = [getSplitBounds(1000), getSplitBounds(300)];

    // Then
    expect(bounds).toEqual([
      { min: 220, max: 734 },
      { min: 220, max: 220 },
    ]);
  });
});
