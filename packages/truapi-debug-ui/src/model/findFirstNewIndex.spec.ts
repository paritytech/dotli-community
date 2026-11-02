// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { findFirstNewIndex } from './findFirstNewIndex.js';

describe('findFirstNewIndex()', () => {
  const buildEvent = (seq: number) => ({ seq });

  it.each([
    { previous: [], next: [0, 1], expected: 0 },
    { previous: [0, 1], next: [0, 1], expected: 2 },
    { previous: [0, 1], next: [1, 2, 3], expected: 1 },
    { previous: [0, 1], next: [7, 8], expected: 0 },
    { previous: [0, 1], next: [], expected: 0 },
  ])(
    "As the debug panel's list, I compare two snapshots and find the first event past the previous one's last ($previous to $next)",
    ({ previous, next, expected }) => {
      // When
      const index = findFirstNewIndex(previous.map(buildEvent), next.map(buildEvent));

      // Then
      expect(index).toBe(expected);
    },
  );

  it.each([
    { lastSeq: -1, next: [0, 1], expected: 0 },
    { lastSeq: 1, next: [0, 1], expected: 2 },
    { lastSeq: 1, next: [1, 2, 3], expected: 1 },
    { lastSeq: 1, next: [7, 8], expected: 0 },
    { lastSeq: 1, next: [], expected: 0 },
  ])(
    "As the debug panel's list, I compare a snapshot with the last seq seen and find the first new event ($lastSeq to $next)",
    ({ lastSeq, next, expected }) => {
      // When
      const index = findFirstNewIndex({ lastSeq }, next.map(buildEvent));

      // Then
      expect(index).toBe(expected);
    },
  );
});
