// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatRate } from './formatRate.js';

describe('formatRate', () => {
  it.each([
    { bytesPerSecond: 300, rate: '300 B/s' },
    { bytesPerSecond: 40_000, rate: '39 kB/s' },
    { bytesPerSecond: 2_516_582, rate: '2.4 MB/s' },
  ])(
    'As a user watching a download at $bytesPerSecond bytes a second, I read its rate and see $rate, never 0 kB/s',
    ({ bytesPerSecond, rate }) => {
      // When
      const formatted = formatRate(bytesPerSecond);

      // Then
      expect(formatted).toBe(rate);
    },
  );
});
