// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { noop } from './noop.js';
import { raceAbort, type Settle } from './raceAbort.js';

/** Anything with a current value and a listener for the changes after it, such as a store. */
export type StatusSource<T> = {
  /** The current status. Never throws. */
  get: () => T;
  /** The listener hears each change after the call, never the current value. Returns its unsubscribe. */
  listen(listener: (value: T) => void): () => void;
};

type Params = {
  signal?: AbortSignal;
};

/**
 * Waits on the source's status until `verdict` settles the wait with `true` or fails it with an error, and fails with the
 * signal's reason when `signal` aborts first. A `verdict` that throws fails the wait with what it threw.
 *
 * @example
 * await waitForStatus(store, shown => shown.phase === 'ready', { signal });
 */
export function waitForStatus<T>(
  source: StatusSource<T>,
  verdict: (status: T) => boolean | Error,
  { signal }: Params = {},
): Promise<void> {
  return raceAbort({ signal, start });

  function start(settle: Settle<void>): () => void {
    // The status there is now settles the wait at once, so a status already there costs no listener.
    if (settleOn(source.get())) {
      return noop;
    }
    return source.listen(settleOn);

    /** Whether `status` settled the wait. */
    function settleOn(status: T): boolean {
      let outcome: boolean | Error;
      try {
        outcome = verdict(status);
      } catch (error) {
        settle.reject(error);
        return true;
      }
      if (outcome === false) {
        return false;
      }
      if (outcome === true) {
        settle.resolve();
      } else {
        settle.reject(outcome);
      }
      return true;
    }
  }
}
