// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getPileDepths, isScrollingToNewest, getVisibleToasts } from './toastPile.js';

describe('toast pile', () => {
  it('As a dotli user, I see only the newest three toasts in the collapsed pile and the newest on top', () => {
    // Given
    const active = buildToasts(['A', 'B', 'C', 'D']);

    // When
    const shown = getVisibleToasts(active, false);
    const depths = getPileDepths(shown, false);

    // Then
    expect(shown.map(toast => toast.label)).toEqual(['B', 'C', 'D']);
    expect([...depths]).toEqual([
      [1, 2],
      [2, 1],
      [3, 0],
    ]);
    expect(depths.has(0)).toBe(false);
  });

  it('As a dotli user, I expand the stack and see every toast, none of them piled', () => {
    // Given
    const active = buildToasts(['A', 'B', 'C', 'D']);

    // When
    const shown = getVisibleToasts(active, true);
    const depths = getPileDepths(shown, true);

    // Then
    expect(shown.map(toast => toast.label)).toEqual(['A', 'B', 'C', 'D']);
    expect([...depths.values()]).toEqual([0, 0, 0, 0]);
  });

  it.each<[number, number | undefined, boolean, boolean]>([
    [5, 4, true, true],
    [5, 4, false, false],
    [3, 4, true, false],
    [4, 4, true, false],
    [4, undefined, true, false],
  ])(
    'As a dotli user, I see %d toasts after %s with the stack expanded %s and it scrolls to the newest only for a new one: %s',
    (count, previous, expanded, scrolls) => {
      // When
      const scrolled = isScrollingToNewest({ count, previous, expanded });

      // Then
      expect(scrolled).toBe(scrolls);
    },
  );
});

function buildToasts(labels: string[]): { id: number; label: string }[] {
  return labels.map((label, id) => ({ id, label }));
}
