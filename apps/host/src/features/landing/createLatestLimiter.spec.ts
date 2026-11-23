// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';
import { createLatestLimiter } from './createLatestLimiter.js';

const PER_SECOND = 15;
const INTERVAL_MS = 1000 / PER_SECOND;

describe('createLatestLimiter', () => {
  it('As a reader of a fast input, I hand the first reading on at once', () => {
    // Given
    const { limiter, values } = setup();

    // When
    limiter.push(1);

    // Then
    expect(values).toEqual([1]);
  });

  it('As a reader of a fast input, I hand on only the latest of the readings one interval brings, at its end', async () => {
    // Given
    const { limiter, values, timers } = setup();
    limiter.push(1);
    limiter.push(2);
    limiter.push(3);

    // When
    await timers.advance(INTERVAL_MS);

    // Then
    expect(values).toEqual([1, 3]);
  });

  it('As a reader of a steady fast input, I hand readings on at most once an interval', async () => {
    // Given
    const { limiter, values, timers } = setup();

    // When
    for (let reading = 1; reading <= 20; reading += 1) {
      limiter.push(reading);
      await timers.advance(10);
    }

    // Then
    expect(values).toEqual([1, 7, 14, 20]);
  });

  it('As a reader of an input that went quiet for an interval, I hand its next reading on at once', async () => {
    // Given
    const { limiter, values, timers } = setup();
    limiter.push(1);
    await timers.advance(INTERVAL_MS);

    // When
    limiter.push(2);

    // Then
    expect(values).toEqual([1, 2]);
  });

  it('As a reader that stops, I drop the reading I held and leave no timer behind', async () => {
    // Given
    const { limiter, values, timers } = setup();
    limiter.push(1);
    limiter.push(2);

    // When
    limiter.stop();
    await timers.advance(INTERVAL_MS);

    // Then
    expect({ values, pending: timers.countPending() }).toEqual({ values: [1], pending: 0 });
  });
});

function setup() {
  const timers = createManualTimers();
  const values: number[] = [];
  const limiter = createLatestLimiter<number>({ perSecond: PER_SECOND, onValue: value => values.push(value), timers });
  return { limiter, values, timers };
}
