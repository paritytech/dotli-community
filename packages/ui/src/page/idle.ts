// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportExpected, spans as S } from '@dotli/metrics';

const PRELOAD_TIMEOUT_MS = 2000;
const PRELOAD_STEP = 'idle_preload';

/** The idle callbacks a browser may offer, the page's own by default. */
export type IdleScheduler = {
  requestIdleCallback?: ((run: () => void, options: { timeout: number }) => number) | undefined;
  cancelIdleCallback?: ((handle: number) => void) | undefined;
};

/**
 * Run `run` once the browser is idle, or after `timeoutMs` where it cannot say. Returns the cancel function.
 */
export function runWhenIdle(run: () => void, timeoutMs: number, scheduler: IdleScheduler = globalThis): () => void {
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
  const timer = setTimeout(run, timeoutMs);
  return () => {
    clearTimeout(timer);
  };
}

/**
 * Preload a lazy component's chunk once the browser is idle, so its first render skips the network.
 * A failed preload is counted as an expected miss and left to the first render, which loads it again and reports a
 * failure that persists. Returns the cancel function.
 */
export function preloadWhenIdle(
  component: { preload: () => Promise<unknown> },
  scheduler: IdleScheduler = globalThis,
): () => void {
  return runWhenIdle(
    () => {
      component.preload().catch((err: unknown) => {
        reportExpected(err, { flow: 'ui', step: PRELOAD_STEP, metric: S.LAZY_CHUNK_LOAD, reason: PRELOAD_STEP });
      });
    },
    PRELOAD_TIMEOUT_MS,
    scheduler,
  );
}
