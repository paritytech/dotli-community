// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { rovingTarget } from './roving.js';

describe('rovingTarget', () => {
  it('As a keyboard user on the debug panel tabs, I move right and left and wrap at the ends', () => {
    // Given five tabs

    // When
    const moves = [rovingTarget('ArrowRight', 1, 5), rovingTarget('ArrowRight', 4, 5), rovingTarget('ArrowLeft', 0, 5)];

    // Then
    expect(moves).toEqual([2, 0, 4]);
  });

  it('As a keyboard user on the debug panel tabs, I jump to the first tab with Home and the last with End', () => {
    // Given five tabs

    // When
    const jumps = [rovingTarget('Home', 3, 5), rovingTarget('End', 0, 5)];

    // Then
    expect(jumps).toEqual([0, 4]);
  });

  it('As a keyboard user on the debug panel tabs, I keep Tab, Enter, Space, letters and the vertical arrows for the page', () => {
    // Given five tabs

    // When
    const others = ['Tab', 'Enter', ' ', 'a', 'ArrowUp', 'ArrowDown'].map(key => rovingTarget(key, 2, 5));

    // Then
    expect(others).toEqual([null, null, null, null, null, null]);
  });

  it('As a keyboard user on the debug panel tabs, I keep Alt, Ctrl and Meta with an arrow for the browser', () => {
    // Given five tabs

    // When
    const moves = ['ArrowRight', 'ArrowLeft', 'Home', 'End'].map(key => rovingTarget(key, 2, 5, true));

    // Then
    expect(moves).toEqual([null, null, null, null]);
  });

  it('As the debug panel with no tabs, I move nowhere', () => {
    // Given no tabs

    // When
    const move = rovingTarget('ArrowRight', 0, 0);

    // Then
    expect(move).toBeNull();
  });
});
