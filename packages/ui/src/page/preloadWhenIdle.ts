// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount, spans as S } from '@dotli/metrics';
import { realTimers, type Timers } from '@dotli/shared';
import { runWhenIdle, type IdleScheduler } from './runWhenIdle.js';

const report = createReporter({ flow: 'ui' });

/** A lazy chunk a caller could not load and went on without. Tagged `outcome` and `reason` (the caller's step). */
const lazyChunkLoadMetric = defineCount<'error'>(S.LAZY_CHUNK_LOAD);

type Params = {
  /** The page's own by default. */
  scheduler?: IdleScheduler | undefined;
  /** The page's own by default. The fallback timeout runs on them. */
  timers?: Timers | undefined;
};

const PRELOAD_TIMEOUT_MS = 2000;
const PRELOAD_STEP = 'idle_preload';

/**
 * Preload a lazy component's chunk once the browser is idle, so its first render skips the network.
 * A failed preload is counted as an expected miss and left to the first render, which loads it again and reports a
 * failure that persists. Returns the cancel function. Never throws or rejects.
 *
 * @example
 * const cancel = preloadWhenIdle(LazyPanel); // LazyPanel is a lazy component, so it has `preload`
 */
export function preloadWhenIdle(
  component: { preload: () => Promise<unknown> },
  { scheduler = globalThis, timers = realTimers }: Params = {},
): () => void {
  return runWhenIdle(
    () => {
      component.preload().catch((error: unknown) => {
        report.expected(error, { step: PRELOAD_STEP, metric: lazyChunkLoadMetric, reason: PRELOAD_STEP });
      });
    },
    PRELOAD_TIMEOUT_MS,
    { scheduler, timers },
  );
}
