// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { clampSplit } from './clampSplit.js';

describe('debug panel body splitter', () => {
  it('As a dotli developer, I drag the body splitter and the panes rebalance within their minimums', () => {
    // Given a body 1000px wide
    const span = 1000;

    // When the splitter is dragged to the middle, near the left and near the right
    const sizes = [500, 40, 990].map(offset => clampSplit(offset, span));

    // Then the list keeps 220px and the detail keeps 260px plus the 6px splitter
    expect(sizes).toEqual([500, 220, 734]);
  });
});
