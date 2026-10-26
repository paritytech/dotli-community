// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatDuration } from './formatDuration.js';

describe('formatDuration', () => {
  it.each([
    { start: 100, now: 220, expected: '120ms' },
    { start: 0, now: 0, expected: '0ms' },
    { start: 10, now: 10.4, expected: '0ms' },
    { start: 10, now: 10.6, expected: '1ms' },
  ])('As a developer, I format $start to $now and read $expected', ({ start, now, expected }) => {
    // Given the start and the explicit now

    // When
    const text = formatDuration(start, { now });

    // Then
    expect(text).toBe(expected);
  });
});
