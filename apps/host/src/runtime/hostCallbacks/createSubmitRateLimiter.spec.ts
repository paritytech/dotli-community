// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';
import {
  SUBMIT_MAX_PER_WINDOW,
  SUBMIT_WINDOW_MS,
  createSubmitRateLimiter,
  type SubmitRateLimiter,
} from './createSubmitRateLimiter.js';

describe('createSubmitRateLimiter', () => {
  it('As a dotli integrator, I spend the window budget on prompts and the next one is denied', () => {
    // Given
    const limiter = createSubmitRateLimiter({ timers: createManualTimers() });

    // When
    const answers = askForPrompts(limiter, SUBMIT_MAX_PER_WINDOW + 1);

    // Then
    expect(answers).toEqual([...Array<boolean>(SUBMIT_MAX_PER_WINDOW).fill(true), false]);
  });

  it('As a dotli integrator, I let prompts age out of the sliding window and exactly their budget comes back', async () => {
    // Given half the budget spent now, and the other half just before the window boundary
    const timers = createManualTimers();
    const limiter = createSubmitRateLimiter({ timers });
    askForPrompts(limiter, SUBMIT_MAX_PER_WINDOW / 2);
    await timers.advance(SUBMIT_WINDOW_MS - 1);
    askForPrompts(limiter, SUBMIT_MAX_PER_WINDOW / 2);

    // When a prompt asks while the window is full, and then the first half ages out
    const whileFull = limiter.allow();
    await timers.advance(1);
    const afterTheFirstHalf = askForPrompts(limiter, SUBMIT_MAX_PER_WINDOW / 2 + 1);

    // Then the window is full until the first half expires, and only that much budget is back
    expect(whileFull).toBe(false);
    expect(afterTheFirstHalf).toEqual([...Array<boolean>(SUBMIT_MAX_PER_WINDOW / 2).fill(true), false]);
  });

  it('As a dotli integrator, I am denied prompts while the window is full and the denials do not extend it', async () => {
    // Given a full window
    const timers = createManualTimers();
    const limiter = createSubmitRateLimiter({ timers });
    askForPrompts(limiter, SUBMIT_MAX_PER_WINDOW);

    // When prompts keep asking inside the window, and the window then passes
    const denied = askForPrompts(limiter, 2);
    await timers.advance(SUBMIT_WINDOW_MS);
    const afterTheWindow = limiter.allow();

    // Then the denied asks did not count, so the budget is back once the window empties
    expect(denied).toEqual([false, false]);
    expect(afterTheWindow).toBe(true);
  });
});

/** Asks the limiter `count` times in a row and returns each answer. */
function askForPrompts(limiter: SubmitRateLimiter, count: number): boolean[] {
  return Array.from({ length: count }, () => limiter.allow());
}
