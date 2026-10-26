// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from './timers.js';

/**
 * How late a timer fires before the page counts as frozen. A running page, hidden or not, fires a lone timer within
 * about a second of when it was due, while a suspended one, such as a backgrounded iOS tab, fires it minutes late.
 */
const FROZEN_LATENESS_MS = 5_000;

/**
 * `work`'s outcome, or the error `timeoutError` makes once `ms` pass first. The timer is cleared either way. `work` is
 * not cancelled, so a caller that owns it stops it on the timeout. Time the page spends frozen does not count, since
 * the work was frozen too: a timer that fires well after it was due waits a whole `ms` again.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  timeoutError: () => Error,
  timers: Timers = realTimers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: unknown;
    const arm = (): void => {
      const due = timers.now() + ms;
      timer = timers.setTimeout(() => {
        if (timers.now() - due > FROZEN_LATENESS_MS) {
          arm();
          return;
        }
        // A factory that throws still settles the call, with what it threw. A non-Error throw is wrapped so the
        // rejection is always an Error and the original value stays on `cause`.
        try {
          reject(timeoutError());
        } catch (error) {
          reject(error instanceof Error ? error : new Error('timeout error factory threw', { cause: error }));
        }
      }, ms);
    };
    arm();
    // Cleared before the caller hears the outcome, so no timer outlives a settled call.
    void work
      .finally(() => {
        timers.clearTimeout(timer);
      })
      .then(resolve, reject);
  });
}
