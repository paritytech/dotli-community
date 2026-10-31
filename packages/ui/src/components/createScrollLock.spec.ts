// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createScrollLock } from './createScrollLock.js';

describe('createScrollLock', () => {
  it('As a dialog sharing the scroll lock, I release my lock twice and the page stays locked until the other dialog releases its own', () => {
    // Given two locks held on one page
    const states: boolean[] = [];
    const lockScroll = createScrollLock({ setLocked: locked => states.push(locked) });
    const first = lockScroll();
    const second = lockScroll();

    // When the first is released twice, then the second once
    first();
    first();
    const afterFirst = states.at(-1);
    second();

    // Then the page stayed locked until the last release, and unlocked once
    expect(afterFirst).toBe(true);
    expect(states.at(-1)).toBe(false);
    expect(states.filter(locked => !locked)).toHaveLength(1);
  });

  it('As two dialogs sharing the scroll lock, I lock twice and the page is locked once', () => {
    // Given one scroll lock on a page
    const states: boolean[] = [];
    const lockScroll = createScrollLock({ setLocked: locked => states.push(locked) });

    // When two dialogs lock it
    lockScroll();
    lockScroll();

    // Then the page was locked once
    expect(states).toEqual([true]);
  });
});
