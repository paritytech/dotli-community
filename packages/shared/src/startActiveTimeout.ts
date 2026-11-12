// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from './realTimers.js';

type Params = {
  /** The active runtime to wait. */
  ms: number;
  /**
   * Called once, `ms` after the start, or `ms` after the wake of a page that was frozen past that due time. A freeze
   * that ended before the due time counts as active runtime.
   */
  onElapsed: () => void;
  /** The clock and timers it runs on. The page's own unless given. */
  timers?: Timers;
};

/**
 * Calls `onElapsed` once `ms` have passed, postponed whenever the page was frozen past the due time, such as a suspended
 * background tab: the wait then starts a whole `ms` of active runtime again, so a page that wakes never finds it over at
 * once. Returns the stop, which cancels a wait not yet elapsed, a postponed one included, and does nothing once the
 * wait elapsed or was stopped.
 */
export function startActiveTimeout({ ms, onElapsed, timers = realTimers }: Params): () => void {
  let timer: unknown;
  arm();
  return () => {
    timers.clearTimeout(timer);
  };

  function arm(): void {
    const due = timers.now() + ms;
    timer = timers.setTimeout(() => {
      // A running page, hidden or not, fires a lone timer within about a second of when it was due, while a suspended
      // one, such as a backgrounded iOS tab, fires it minutes late. Past 5 seconds the page counts as frozen.
      if (timers.now() - due > 5_000) {
        arm();
        return;
      }
      onElapsed();
    }, ms);
  }
}
