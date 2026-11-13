// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createNavComboboxState, type NavKey } from './navComboboxState.js';

describe('navComboboxState', () => {
  it('As the name input, I leave a key pressed before the suggestions load to the form', () => {
    // Given no suggestions have registered a handler
    const state = createNavComboboxState();

    // When the visitor presses Enter
    const taken = state.press('Enter');

    // Then the suggestions did not take it
    expect(taken).toBe(false);
  });

  it('As the suggestions, I take the keys my handler answers true for', () => {
    // Given a handler that takes only the arrow keys
    const state = createNavComboboxState();
    state.handleKeys(key => key === 'ArrowDown' || key === 'ArrowUp');
    const keys: NavKey[] = ['ArrowDown', 'Enter'];

    // When the visitor presses an arrow key and Enter
    const taken = keys.map(key => state.press(key));

    // Then only the arrow key was taken
    expect(taken).toEqual([true, false]);
  });

  it('As the suggestions, I run an old cleanup and a newer handler stays in place', () => {
    // Given an old handler replaced by a newer one that takes every key
    const state = createNavComboboxState();
    const cleanupOld = state.handleKeys(() => false);
    state.handleKeys(() => true);

    // When the old handler's cleanup runs and the visitor presses Enter
    cleanupOld();
    const taken = state.press('Enter');

    // Then the newer handler took the key
    expect(taken).toBe(true);
  });
});
