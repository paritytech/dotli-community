// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { raceAbort, type Settle } from './raceAbort.js';
import { realTimers, type Timers } from './realTimers.js';
import { startActiveTimeout } from './startActiveTimeout.js';

type Params<T> = {
  work: Promise<T>;
  ms: number;
  timeoutError: () => Error;
  timers?: Timers;
  signal?: AbortSignal;
};

/**
 * `work`'s outcome, or the error `timeoutError` makes once `ms` pass first, or `signal.reason` as soon as `signal`
 * aborts. The wait stops either way. `work` is not cancelled, so a caller that owns it stops it on the timeout or the
 * abort. Only active runtime counts, since the work was frozen too: a deadline the page was frozen past starts a whole
 * `ms` again on waking.
 *
 * @example
 * await withTimeout({ work: fetchBlock(), ms: 10_000,
 *   timeoutError: () => new Error('The block fetch took over 10s') }); // work runs on after a timeout
 */
export function withTimeout<T>({ work, ms, timeoutError, timers = realTimers, signal }: Params<T>): Promise<T> {
  let settleRace: Settle<T> | undefined;
  // Taken before the abort check, so a later rejection of `work` is never left unhandled. With no race started, no one
  // is left to hear it.
  void work.then(
    value => {
      settleRace?.resolve(value);
    },
    (error: unknown) => {
      settleRace?.reject(error);
    },
  );
  return raceAbort({ signal, start });

  function start(settle: Settle<T>): () => void {
    settleRace = settle;
    return startActiveTimeout({
      ms,
      timers,
      onElapsed() {
        // A factory that throws still settles the call, with what it threw. A non-Error throw is wrapped so the
        // rejection is always an Error and the original value stays on `cause`.
        try {
          settle.reject(timeoutError());
        } catch (error) {
          settle.reject(error instanceof Error ? error : new Error('timeout error factory threw', { cause: error }));
        }
      },
    });
  }
}
