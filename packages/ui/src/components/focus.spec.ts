// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createScrollLock } from './focus.js';

describe('createScrollLock', () => {
  it('As a visitor, the page stays locked until the last lock is released, and a release twice counts once', () => {
    // Given
    const states: boolean[] = [];
    const lockScroll = createScrollLock(locked => states.push(locked));
    const first = lockScroll();
    const second = lockScroll();

    // When
    first();
    first();

    // Then
    expect(states.at(-1)).toBe(true);

    // When
    second();

    // Then
    expect(states.at(-1)).toBe(false);
    expect(states.filter(locked => !locked)).toHaveLength(1);
  });
});
