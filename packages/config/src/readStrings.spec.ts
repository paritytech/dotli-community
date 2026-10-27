// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readStrings } from './readStrings.js';

describe('readStrings', () => {
  it('As an operator, I give an array of strings and the same array is read', () => {
    // Given an array of strings
    const value = ['previewnet', 'paseo'];

    // When it is read as strings
    const strings = readStrings(value, 'config.enabled');

    // Then it is returned as it is
    expect(strings).toBe(value);
  });

  it.each([
    { name: 'an array with a number', value: ['previewnet', 1], found: 'an array with a non-string item' },
    { name: 'a number', value: 1, found: 'number' },
    { name: 'null', value: null, found: 'null' },
  ])('As an operator, I give $name and the error names the path and $found', ({ value, found }) => {
    // When a value that is not an array of strings is read as strings
    const read = () => readStrings(value, 'config.enabled');

    // Then it throws with the path and what was found
    expect(read).toThrow(`config.enabled must be an array of strings, got ${found}.`);
  });
});
