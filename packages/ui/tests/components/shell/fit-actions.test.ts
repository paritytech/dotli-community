// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fitActions, PINNED } from '../../../src/components/shell/topbar/fit.js';

const item = (priority: number, width = 30): { width: number; priority: number } => ({ width, priority });

describe('fitActions', () => {
  it('As a desktop user, every item stays in the bar when they all fit, the gaps included', () => {
    // Given: 3 × 30 + 2 gaps of 5.
    const items = [item(PINNED), item(2), item(1)];

    // When / Then
    expect(fitActions(items, 100, 5, 30)).toEqual([false, false, false]);
  });

  it('As a user on a narrower window, the lowest priority items go into More first, counting the More button', () => {
    // Given: auth, network 5, permissions 3, settings 1.
    const items = [item(PINNED), item(5), item(3), item(1)];

    // When / Then: 4 items need 120; collapsing settings leaves 3 + More = 120.
    expect(fitActions(items, 119, 0, 30)).toEqual([false, false, true, true]);
    expect(fitActions(items, 120, 0, 30)).toEqual([false, false, false, false]);
    expect(fitActions(items, 90, 0, 30)).toEqual([false, false, true, true]);
    expect(fitActions(items, 60, 0, 30)).toEqual([false, true, true, true]);
  });

  it('As a phone user, a pinned item never collapses, even without room for it', () => {
    // When / Then
    expect(fitActions([item(PINNED), item(1)], 0, 0, 30)).toEqual([false, true]);
    expect(fitActions([item(PINNED)], 0, 0, 30)).toEqual([false]);
  });

  it('As a user, of two items with the same priority the earlier one in the bar goes first', () => {
    // When / Then: with a More button that takes no room, one has to go.
    expect(fitActions([item(1), item(1), item(9)], 60, 0, 0)).toEqual([true, false, false]);
  });

  it('As a user, a wide item is collapsed by its priority, not its width', () => {
    // Given: the wide item has the higher priority.
    const items = [item(PINNED, 30), item(5, 200), item(1, 30)];

    // When / Then: settings goes first, then the wide one.
    expect(fitActions(items, 150, 0, 30)).toEqual([false, true, true]);
  });
});
