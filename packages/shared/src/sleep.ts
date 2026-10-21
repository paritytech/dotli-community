// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toAbortError } from './abort.js';
import { realTimers, type Timers } from './timers.js';

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts, clearing its timer. */
export function sleep(
  ms: number,
  signal?: AbortSignal,
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'> = realTimers,
): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(toAbortError(signal.reason, 'The wait was aborted'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      timers.clearTimeout(timer);
      reject(toAbortError(signal?.reason, 'The wait was aborted'));
    };
    const timer = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
