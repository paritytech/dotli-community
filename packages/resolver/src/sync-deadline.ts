// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounded waits for chain synchronization.
 *
 * `api.whenReady()` never settles when the peer set is unreachable, so every
 * caller has to race a timer. The rejection carries `NetworkSyncTimeoutError`
 * so the host can name the real cause rather than whichever generic timer
 * fired first.
 */

import { NetworkSyncTimeoutError } from "./errors";

/** Race `work` against a `NetworkSyncTimeoutError` naming `chain`. */
export function raceSyncTimeout<T>(
  work: Promise<T>,
  chain: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new NetworkSyncTimeoutError(chain, timeoutMs));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Apply a caller's remaining budget to an already-bounded wait.
 *
 * Returns `work` untouched when the caller has no budget, or when its budget
 * is no tighter than the cap `work` already enforces. No protocol method
 * budget reaches the cap today, so that second arm is an invariant.
 */
export function withSyncBudget<T>(
  work: Promise<T>,
  chain: string,
  requestedMs: number | undefined,
  capMs: number,
): Promise<T> {
  if (requestedMs === undefined || requestedMs >= capMs) {
    return work;
  }
  return raceSyncTimeout(work, chain, requestedMs);
}
