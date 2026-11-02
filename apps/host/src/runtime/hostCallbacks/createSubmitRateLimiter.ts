// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';

type Params = {
  /** The clock the window is measured on. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
};

/** One submit rate limiter, as its factory builds it. */
export type SubmitRateLimiter = ReturnType<typeof createSubmitRateLimiter>;

export const SUBMIT_WINDOW_MS = 10_000;
export const SUBMIT_MAX_PER_WINDOW = 20;

/** Allows at most `SUBMIT_MAX_PER_WINDOW` prompts in any sliding `SUBMIT_WINDOW_MS`. */
export function createSubmitRateLimiter({ timers = realTimers }: Params = {}) {
  const timestamps: number[] = [];
  return {
    /** Returns whether one more prompt fits the window, and counts it when it does. A denial counts nothing. */
    allow(): boolean {
      const now = timers.now();
      let oldest = timestamps[0];
      while (oldest !== undefined && oldest <= now - SUBMIT_WINDOW_MS) {
        timestamps.shift();
        oldest = timestamps[0];
      }
      if (timestamps.length >= SUBMIT_MAX_PER_WINDOW) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}
