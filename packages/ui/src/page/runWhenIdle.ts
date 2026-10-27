// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';

/** The idle callbacks a browser may offer, the page's own by default. */
export type IdleScheduler = {
  requestIdleCallback?: ((run: () => void, options: { timeout: number }) => number) | undefined;
  cancelIdleCallback?: ((handle: number) => void) | undefined;
};

type Params = {
  /** The page's own by default. */
  scheduler?: IdleScheduler | undefined;
  /** The page's own by default. The fallback timeout runs on them. */
  timers?: Timers | undefined;
};

/**
 * Run `run` once the browser is idle, or after `timeoutMs` on `timers` where it cannot say. Returns the cancel
 * function, which is safe to call after the run. Never throws.
 */
export function runWhenIdle(
  run: () => void,
  timeoutMs: number,
  { scheduler = globalThis, timers = realTimers }: Params = {},
): () => void {
  const { requestIdleCallback, cancelIdleCallback } = scheduler;
  // Both or neither: happy-dom has only one of them, so it takes the timer.
  if (typeof requestIdleCallback === 'function' && typeof cancelIdleCallback === 'function') {
    // Bound now so the cancel pairs with the request that scheduled it.
    const cancel = cancelIdleCallback.bind(scheduler);
    const handle = requestIdleCallback.call(scheduler, run, { timeout: timeoutMs });
    return () => {
      cancel(handle);
    };
  }
  const timer = timers.setTimeout(run, timeoutMs);
  return () => {
    timers.clearTimeout(timer);
  };
}
