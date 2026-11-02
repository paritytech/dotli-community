// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getFailureReason, parseReason } from './getFailureReason.js';

describe('failure reasons', () => {
  it("As a caller, I read a failure's reason back and get the name and message of the error that failed", () => {
    // Given
    const errors = [new TypeError('the peer is gone'), new RangeError('expected: a word')];

    // When
    const parts = errors.map(error => parseReason(getFailureReason(error)));

    // Then
    expect(parts).toEqual([
      { name: 'TypeError', message: 'the peer is gone' },
      { name: 'RangeError', message: 'expected: a word' },
    ]);
  });

  it('As a caller, I read a reason with no name and get the message of a plain error', () => {
    // When
    const parts = parseReason('the peer is gone');

    // Then
    expect(parts).toEqual({ name: 'Error', message: 'the peer is gone' });
  });
});
