// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { runEvery } from './runEvery.js';
import { catchError } from './testing/catchError.js';

describe('runEvery', () => {
  it('As a dotli integrator, I run every step past one that throws and get that error back', () => {
    // Given three steps, the second of which throws
    const ran: string[] = [];
    const error = new Error('b');
    const steps = [
      () => ran.push('a'),
      () => {
        ran.push('b');
        throw error;
      },
      () => ran.push('c'),
    ];

    // When they run
    const caught = catchError(() => {
      runEvery(steps, 'running failed');
    });

    // Then all three ran and the thrown error is that same error
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(caught).toBe(error);
  });

  it('As a dotli integrator, I run every step past two that throw and get an AggregateError of both with my message', () => {
    // Given three steps, the first and the third of which throw
    const first = new Error('a');
    const second = new Error('c');
    const steps = [
      () => {
        throw first;
      },
      () => undefined,
      () => {
        throw second;
      },
    ];

    // When they run
    const caught = catchError(() => {
      runEvery(steps, 'running failed');
    });

    // Then the error is an AggregateError of both, in order, with the given message
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toHaveProperty('errors', [first, second]);
    expect(caught).toHaveProperty('message', 'running failed');
  });
});
