// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readStrings } from './readStrings.js';

describe('readStrings', () => {
  it('As the broker, I read the strings of an array and none of anything else', () => {
    // Given
    const mixed: unknown = ['0xa', 1, null, '0xb'];

    // When
    const fromArray = readStrings(mixed);
    const fromString = readStrings('0xa');

    // Then
    expect(fromArray).toEqual(['0xa', '0xb']);
    expect(fromString).toEqual([]);
  });
});
