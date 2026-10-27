// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeValueType } from './describeValueType.js';

describe('describeValueType', () => {
  it.each([
    { name: 'null', value: null, expected: 'null' },
    { name: 'undefined', value: undefined, expected: 'undefined' },
    { name: 'an empty array', value: [], expected: 'an array' },
    { name: 'an array of strings', value: ['previewnet'], expected: 'an array' },
    { name: 'an object', value: {}, expected: 'object' },
    { name: 'a string', value: 'previewnet', expected: 'string' },
    { name: 'a number', value: 1, expected: 'number' },
    { name: 'a boolean', value: true, expected: 'boolean' },
    { name: 'a function', value: () => undefined, expected: 'function' },
  ])('As an operator, I give $name and the error names it $expected', ({ value, expected }) => {
    // When a value an error message reports is described
    const description = describeValueType(value);

    // Then null and arrays get their own words and anything else its typeof
    expect(description).toBe(expected);
  });
});
