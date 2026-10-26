// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { raceAbort, type Settle } from './raceAbort.js';
import { realTimers, type Timers } from './realTimers.js';

type Params<T> = {
  work: Promise<T>;
  ms: number;
  timeoutError: () => Error;
  timers?: Timers;
  signal?: AbortSignal;
};

/**
 * How late a timer fires before the page counts as frozen. A running page, hidden or not, fires a lone timer within
 * about a second of when it was due, while a suspended one, such as a backgrounded iOS tab, fires it minutes late.
 */
const FROZEN_LATENESS_MS = 5_000;

const ABORT_MESSAGE = 'The timed work was aborted';

/**
 * `work`'s outcome, or the error `timeoutError` makes once `ms` pass first, or an AbortError as soon as `signal` aborts.
 * The timer is cleared either way. `work` is not cancelled, so a caller that owns it stops it on the timeout or the
 * abort. Time the page spends frozen does not count, since the work was frozen too: a timer that fires well after it was
 * due waits a whole `ms` again.
 */
export function withTimeout<T>({ work, ms, timeoutError, timers = realTimers, signal }: Params<T>): Promise<T> {
  let timer: unknown;
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
  return raceAbort({ signal, abortMessage: ABORT_MESSAGE, start });

  function start(settle: Settle<T>): () => void {
    settleRace = settle;
    arm(settle);
    return stop;
  }

  function arm(settle: Settle<T>): void {
    const due = timers.now() + ms;
    timer = timers.setTimeout(() => {
      if (timers.now() - due > FROZEN_LATENESS_MS) {
        arm(settle);
        return;
      }
      // A factory that throws still settles the call, with what it threw. A non-Error throw is wrapped so the
      // rejection is always an Error and the original value stays on `cause`.
      try {
        settle.reject(timeoutError());
      } catch (error) {
        settle.reject(error instanceof Error ? error : new Error('timeout error factory threw', { cause: error }));
      }
    }, ms);
  }

  function stop(): void {
    timers.clearTimeout(timer);
  }
}
