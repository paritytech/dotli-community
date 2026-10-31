// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { noop } from './noop.js';
import { raceAbort, type Settle } from './raceAbort.js';
import type { StatusCell } from './createStatusCell.js';

type Params = {
  signal?: AbortSignal;
};

/**
 * Waits on the status until `verdict` settles the wait with `true` or fails it with an error, and fails with the
 * signal's reason when `signal` aborts first.
 *
 * @example
 * await waitForStatus(createStoreStatus(store), shown => shown.phase === 'ready', { signal });
 */
export function waitForStatus<T>(
  cell: Pick<StatusCell<T>, 'get' | 'subscribe'>,
  verdict: (status: T) => boolean | Error,
  { signal }: Params = {},
): Promise<void> {
  return raceAbort({ signal, start });

  function start(settle: Settle<void>): () => void {
    // The status there is now settles the wait at once, so a cell already there costs no subscription.
    if (settleOn(cell.get())) {
      return noop;
    }
    return cell.subscribe(settleOn);

    /** Whether `status` settled the wait. */
    function settleOn(status: T): boolean {
      const outcome = verdict(status);
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
