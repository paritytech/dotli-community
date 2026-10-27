// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isStringArray } from './isStringArray.js';

describe('isStringArray', () => {
  it.each([
    { name: 'an empty array', value: [], expected: true },
    { name: 'an array of strings', value: ['a', 'b'], expected: true },
    { name: 'an array of a string and a number', value: ['a', 1], expected: false },
    { name: 'an array of a string and null', value: ['a', null], expected: false },
    { name: 'an array of arrays', value: [['a']], expected: false },
    { name: 'a string', value: 'a', expected: false },
    { name: 'an object', value: { 0: 'a' }, expected: false },
    { name: 'null', value: null, expected: false },
    { name: 'undefined', value: undefined, expected: false },
  ])('As a developer, I check $name and get $expected', ({ value, expected }) => {
    // When a value read from an untyped source is checked
    const result = isStringArray(value);

    // Then only an array whose every item is a string passes
    expect(result).toBe(expected);
  });
});
