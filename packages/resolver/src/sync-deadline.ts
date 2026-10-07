// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `api.whenReady()` never settles without reachable peers, so callers race a timer that names the cause.

import { NetworkSyncTimeoutError } from './errors.js';

export function raceSyncTimeout<T>(work: Promise<T>, chain: string, timeoutMs: number): Promise<T> {
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

/** Apply a caller's budget to a wait already bounded by `capMs`, only when it is tighter. */
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
