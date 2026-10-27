// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getKeyDelta } from './getKeyDelta.js';

describe('debug panel divider keys', () => {
  it('As a keyboard user of the debug panel, I press an arrow along a divider and it moves 16px, or 64px with Shift', () => {
    // Given a divider of each orientation

    // When
    const moves = [
      getKeyDelta({ key: 'ArrowUp', orientation: 'horizontal', large: false }),
      getKeyDelta({ key: 'ArrowDown', orientation: 'horizontal', large: true }),
      getKeyDelta({ key: 'ArrowLeft', orientation: 'vertical', large: true }),
      getKeyDelta({ key: 'ArrowRight', orientation: 'vertical', large: false }),
    ];

    // Then
    expect(moves).toEqual([-16, 64, -64, 16]);
  });

  it('As a keyboard user of the debug panel, I press Tab, Enter, a letter or a cross-axis arrow on a divider and the page keeps the key', () => {
    // Given a divider that runs across the panel

    // When
    const others = ['Tab', 'Enter', 'a', 'ArrowLeft', 'ArrowRight'].map(key =>
      getKeyDelta({ key, orientation: 'horizontal', large: false }),
    );

    // Then
    expect(others).toEqual([null, null, null, null, null]);
  });

  it('As a keyboard user of the debug panel, I press an arrow with Alt, Ctrl or Cmd on a divider and the browser keeps the key', () => {
    // Given an arrow pressed with a browser shortcut modifier held

    // When
    const move = getKeyDelta({ key: 'ArrowLeft', orientation: 'vertical', large: false, modified: true });

    // Then
    expect(move).toBeNull();
  });
});
