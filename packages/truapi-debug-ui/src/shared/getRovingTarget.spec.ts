// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getRovingTarget } from './getRovingTarget.js';

describe('getRovingTarget()', () => {
  it('As a keyboard user on the debug panel tabs, I move right and left and the focus wraps at the ends', () => {
    // Given five tabs

    // When
    const moves = [
      getRovingTarget({ key: 'ArrowRight', index: 1, count: 5 }),
      getRovingTarget({ key: 'ArrowRight', index: 4, count: 5 }),
      getRovingTarget({ key: 'ArrowLeft', index: 0, count: 5 }),
    ];

    // Then
    expect(moves).toEqual([2, 0, 4]);
  });

  it('As a keyboard user on the debug panel tabs, I press Home or End and the focus jumps to the first or the last tab', () => {
    // Given five tabs

    // When
    const jumps = [
      getRovingTarget({ key: 'Home', index: 3, count: 5 }),
      getRovingTarget({ key: 'End', index: 0, count: 5 }),
    ];

    // Then
    expect(jumps).toEqual([0, 4]);
  });

  it('As a keyboard user on the debug panel tabs, I press Tab, Enter, Space, a letter or a vertical arrow and the page keeps the key', () => {
    // Given five tabs

    // When
    const others = ['Tab', 'Enter', ' ', 'a', 'ArrowUp', 'ArrowDown'].map(key =>
      getRovingTarget({ key, index: 2, count: 5 }),
    );

    // Then
    expect(others).toEqual([null, null, null, null, null, null]);
  });

  it('As a keyboard user on the debug panel tabs, I press an arrow with Alt, Ctrl or Meta and the browser keeps the key', () => {
    // Given five tabs

    // When
    const moves = ['ArrowRight', 'ArrowLeft', 'Home', 'End'].map(key =>
      getRovingTarget({ key, index: 2, count: 5, modified: true }),
    );

    // Then
    expect(moves).toEqual([null, null, null, null]);
  });

  it('As the debug panel with no tabs, I take an arrow and the focus moves nowhere', () => {
    // Given no tabs

    // When
    const move = getRovingTarget({ key: 'ArrowRight', index: 0, count: 0 });

    // Then
    expect(move).toBeNull();
  });
});
