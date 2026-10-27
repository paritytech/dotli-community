// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fitActions, PINNED, type FitItem } from './fit.js';

describe('fitActions', () => {
  it('As a desktop user, I see every item stay in the bar when they all fit, and the gaps count', () => {
    // Given three items of 30 and two gaps of 5
    const items = [buildItem(PINNED), buildItem(2), buildItem(1)];

    // When
    const collapsed = fitActions({ items, available: 100, gap: 5, moreWidth: 30 });

    // Then
    expect(collapsed).toEqual([false, false, false]);
  });

  it.each([
    [119, [false, false, true, true]],
    [120, [false, false, false, false]],
    [90, [false, false, true, true]],
    [60, [false, true, true, true]],
  ])(
    'As a user on a window %d wide, I see the lowest priority items go into More first, and the More button counts',
    (available, expected) => {
      // Given auth, network 5, permissions 3 and settings 1, which need 120. Collapsing settings leaves 3 + More = 120
      const items = [buildItem(PINNED), buildItem(5), buildItem(3), buildItem(1)];

      // When
      const collapsed = fitActions({ items, available, gap: 0, moreWidth: 30 });

      // Then
      expect(collapsed).toEqual(expected);
    },
  );

  it('As a phone user, I keep a pinned item in the bar and it never collapses, even without room for it', () => {
    // Given
    const withOther = [buildItem(PINNED), buildItem(1)];
    const alone = [buildItem(PINNED)];

    // When
    const collapsedWithOther = fitActions({ items: withOther, available: 0, gap: 0, moreWidth: 30 });
    const collapsedAlone = fitActions({ items: alone, available: 0, gap: 0, moreWidth: 30 });

    // Then
    expect(collapsedWithOther).toEqual([false, true]);
    expect(collapsedAlone).toEqual([false]);
  });

  it('As a user, I see the earlier of two items with the same priority go first and the later one stay', () => {
    // Given a More button that takes no room, so one has to go
    const items = [buildItem(1), buildItem(1), buildItem(9)];

    // When
    const collapsed = fitActions({ items, available: 60, gap: 0, moreWidth: 0 });

    // Then
    expect(collapsed).toEqual([true, false, false]);
  });

  it('As a user, I see a wide item collapse by its priority and not by its width', () => {
    // Given the wide item has the higher priority
    const items = [buildItem(PINNED, 30), buildItem(5, 200), buildItem(1, 30)];

    // When
    const collapsed = fitActions({ items, available: 150, gap: 0, moreWidth: 30 });

    // Then settings goes first, then the wide one
    expect(collapsed).toEqual([false, true, true]);
  });
});

function buildItem(priority: number, width = 30): FitItem {
  return { width, priority };
}
