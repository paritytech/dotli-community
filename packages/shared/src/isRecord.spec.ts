// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isRecord } from './isRecord.js';

const NULL_PROTOTYPE: unknown = Object.create(null);

describe('isRecord', () => {
  it.each([
    { name: 'an empty object', value: {}, expected: true },
    { name: 'an object with keys', value: { a: 1 }, expected: true },
    { name: 'an object without a prototype', value: NULL_PROTOTYPE, expected: true },
    { name: 'null', value: null, expected: false },
    { name: 'undefined', value: undefined, expected: false },
    { name: 'an empty array', value: [], expected: false },
    { name: 'an array of objects', value: [{}], expected: false },
    { name: 'a string', value: 'text', expected: false },
    { name: 'a number', value: 1, expected: false },
    { name: 'a boolean', value: true, expected: false },
  ])('As a developer, I check $name and get $expected', ({ value, expected }) => {
    // When a value read from an untyped source is checked
    const result = isRecord(value);

    // Then only a non-null, non-array object passes
    expect(result).toBe(expected);
  });
});
