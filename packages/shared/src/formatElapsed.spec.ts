// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatElapsed } from './formatElapsed.js';

describe('formatElapsed', () => {
  it.each([
    { start: 1000, now: 2250, expected: '+1.250s' },
    { start: 0, now: 0, expected: '+0.000s' },
    { start: 0, now: 12_345.6, expected: '+12.346s' },
  ])('As a developer, I format $start to $now and read $expected', ({ start, now, expected }) => {
    // Given the start and the explicit now

    // When
    const text = formatElapsed(start, { now });

    // Then
    expect(text).toBe(expected);
  });
});
