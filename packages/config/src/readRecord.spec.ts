// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readRecord } from './readRecord.js';

describe('readRecord', () => {
  it('As an operator, I give an object and the same object is read', () => {
    // Given an object
    const value = { rpcs: [] };

    // When it is read as a record
    const record = readRecord(value, 'config');

    // Then it is returned as it is
    expect(record).toBe(value);
  });

  it.each([
    { name: 'null', value: null, found: 'null' },
    { name: 'an array', value: [], found: 'an array' },
    { name: 'a string', value: 'previewnet', found: 'string' },
  ])('As an operator, I give $name and the error names the path and $found', ({ value, found }) => {
    // When a value that is not an object is read as a record
    const read = () => readRecord(value, 'config.networks');

    // Then it throws with the path and what was found
    expect(read).toThrow(`config.networks must be an object, got ${found}.`);
  });
});
