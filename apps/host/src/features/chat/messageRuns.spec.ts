// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { endsRun } from './messageRuns.js';

// The start of a clock minute.
const MINUTE = 28_333_333 * 60_000;

describe('message runs', () => {
  it('As a reader, I see one time for the messages an author sends within a minute', () => {
    // Given
    const first = { author: 'product' as const, timestamp: MINUTE + 1_000 };
    const second = { author: 'product' as const, timestamp: MINUTE + 50_000 };

    // When
    const ends = [endsRun(first, second), endsRun(second, undefined)];

    // Then
    expect(ends).toEqual([false, true]);
  });

  it('As a reader, I see a time where the author changes or a new minute starts', () => {
    // Given
    const mine = { author: 'user' as const, timestamp: MINUTE + 59_000 };
    const theirs = { author: 'product' as const, timestamp: MINUTE + 59_500 };
    const nextMinute = { author: 'user' as const, timestamp: MINUTE + 60_000 };

    // When
    const ends = [endsRun(mine, theirs), endsRun(mine, nextMinute)];

    // Then
    expect(ends).toEqual([true, true]);
  });
});
