// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `work`'s outcome, or the error `timeoutError` makes once `ms` pass first. The timer is cleared either way. `work` is
 * not cancelled, so a caller that owns it stops it on the timeout.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A factory that throws still settles the call, with what it threw. A non-Error throw is wrapped so the
      // rejection is always an Error and the original value stays on `cause`.
      try {
        reject(timeoutError());
      } catch (error) {
        reject(error instanceof Error ? error : new Error('timeout error factory threw', { cause: error }));
      }
    }, ms);
    // Cleared before the caller hears the outcome, so no timer outlives a settled call.
    void work
      .finally(() => {
        clearTimeout(timer);
      })
      .then(resolve, reject);
  });
}
