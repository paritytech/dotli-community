// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getKeys } from './getKeys.js';

describe('getKeys', () => {
  it('As a developer, I list a record and get its own keys in insertion order', () => {
    // Given a record with typed keys
    const record = { low: 1, high: 2 };

    // When its keys are listed
    const keys = getKeys(record);

    // Then every own key comes back, in the order it was set
    expect(keys).toEqual(['low', 'high']);
  });

  it('As a developer, I list a record and get none of its inherited, symbol or non-enumerable keys', () => {
    // Given a record that inherits a key, holds a symbol key and hides one key
    const record = { own: 3, [Symbol('tag')]: 4 };
    Object.defineProperty(record, 'hidden', { value: 2, enumerable: false });
    Reflect.setPrototypeOf(record, { inherited: 1 });

    // When its keys are listed
    const keys = getKeys(record);

    // Then only its own enumerable string key comes back
    expect(keys).toEqual(['own']);
  });

  it('As a developer, I list an empty record and get no keys', () => {
    // Given the empty record
    const record = {};

    // When its keys are listed
    const keys = getKeys(record);

    // Then the list is empty
    expect(keys).toEqual([]);
  });
});
