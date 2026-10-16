// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { handlesKey, stopAt, stopForKey } from './step-slider.js';

describe('step slider', () => {
  it.each([
    [0, 0],
    [0.16, 0],
    [0.17, 1],
    [0.5, 2],
    [0.84, 3],
    [1, 3],
    [-0.4, 0],
    [1.7, 3],
  ])('As a pointer at %d of the track, I land on stop %d of four', (fraction, stop) => {
    // Then
    expect(stopAt(fraction, 4)).toBe(stop);
  });

  it.each<[string, number, number | null]>([
    ['ArrowRight', 1, 2],
    ['ArrowUp', 1, 2],
    ['ArrowLeft', 1, 0],
    ['ArrowDown', 1, 0],
    ['Home', 2, 0],
    ['End', 1, 3],
    ['ArrowRight', 3, null],
    ['ArrowUp', 3, null],
    ['ArrowLeft', 0, null],
    ['ArrowDown', 0, null],
    ['End', 3, null],
    ['Home', 0, null],
    ['Enter', 2, 2],
    [' ', 2, 2],
    ['Tab', 2, null],
    ['a', 2, null],
  ])('As a keyboard user pressing %j on stop %d of four, I commit stop %j', (key, index, stop) => {
    // Then
    expect(stopForKey(key, index, 4)).toBe(stop);
  });

  it.each<[string, boolean]>([
    ['ArrowRight', true],
    ['End', true],
    ['Enter', true],
    [' ', true],
    ['Tab', false],
    ['a', false],
  ])('As a keyboard user pressing %j, the slider takes the key from the page: %j', (key, handled) => {
    // Then
    expect(handlesKey(key)).toBe(handled);
  });
});
