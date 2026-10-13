// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { pileDepths, scrollsToNewest, visibleToasts } from './toast-pile.js';

const toasts = (labels: string[]): { id: number; label: string }[] => labels.map((label, id) => ({ id, label }));

describe('toast pile', () => {
  it('As a dotli user, only the newest three toasts are in the collapsed pile, the newest on top', () => {
    // Given
    const active = toasts(['A', 'B', 'C', 'D']);

    // When
    const shown = visibleToasts(active, false);
    const depths = pileDepths(shown, false);

    // Then
    expect(shown.map(t => t.label)).toEqual(['B', 'C', 'D']);
    expect([...depths]).toEqual([
      [1, 2],
      [2, 1],
      [3, 0],
    ]);
    expect(depths.has(0)).toBe(false);
  });

  it('As a dotli user, an expanded stack shows every toast, none of them piled', () => {
    // Given
    const active = toasts(['A', 'B', 'C', 'D']);

    // When
    const shown = visibleToasts(active, true);
    const depths = pileDepths(shown, true);

    // Then
    expect(shown.map(t => t.label)).toEqual(['A', 'B', 'C', 'D']);
    expect([...depths.values()]).toEqual([0, 0, 0, 0]);
  });

  it('As a dotli user, only a new toast in an expanded stack scrolls to it', () => {
    // Given / When / Then
    expect(scrollsToNewest(5, 4, true)).toBe(true);
    expect(scrollsToNewest(5, 4, false)).toBe(false);
    expect(scrollsToNewest(3, 4, true)).toBe(false);
    expect(scrollsToNewest(4, 4, true)).toBe(false);
    expect(scrollsToNewest(4, undefined, true)).toBe(false);
  });
});
