// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isRecord, stringsOf } from './json-shape.js';

describe('json shape', () => {
  it('As the broker, I tell a JSON object from an array, null and a primitive', () => {
    // Given
    const values: unknown[] = [{}, { event: 'stop' }, [], null, 'stop', 1];

    // When
    const verdicts = values.map(isRecord);

    // Then
    expect(verdicts).toEqual([true, true, false, false, false, false]);
  });

  it('As the broker, I read the strings of an array and none of anything else', () => {
    // Given
    const mixed: unknown = ['0xa', 1, null, '0xb'];

    // When
    const fromArray = stringsOf(mixed);
    const fromString = stringsOf('0xa');

    // Then
    expect(fromArray).toEqual(['0xa', '0xb']);
    expect(fromString).toEqual([]);
  });
});
