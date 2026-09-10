// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounded waits for chain synchronization.
 *
 * `api.whenReady()` never settles when the peer set is unreachable, so every
 * caller that awaits it has to race a timer or risk sitting on the loading
 * overlay forever. The rejection carries `NetworkSyncTimeoutError` so the host
 * can name the real cause instead of reporting whichever generic timer fired
 * first.
 *
 * Both helpers clear their timer once the race settles. A 180s timer left
 * running after a successful sync keeps the event loop awake for no reason.
 */

import { NetworkSyncTimeoutError } from "./errors";

/**
 * Race `work` against a sync-timeout rejection.
 *
 * @param chain Human-readable chain name, used in the error message.
 */
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
 * is no tighter than the cap `work` already enforces. The `>= capMs` arm is an
 * invariant rather than a live branch: every protocol method budget is well
 * under the cap today, so a caller that trips it has raised a method timeout
 * past the resolver's own ceiling and wants the resolver's error, not a
 * duplicate one.
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
