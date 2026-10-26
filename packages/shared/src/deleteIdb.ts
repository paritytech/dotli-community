// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { raceAbort, type Settle } from './raceAbort.js';
import { realTimers, type Timers } from './realTimers.js';
import { withTimeout } from './withTimeout.js';

type Params = {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  timers?: Timers;
};

/** Long enough for another tab to close its connection, short enough that a stuck one does not hold up init. */
const DELETE_TIMEOUT_MS = 3_000;

/**
 * Deletes `name`. A delete an open connection blocks stays queued in the browser and runs once that connection closes,
 * so it waits for that, rejecting if `timeoutMs` pass first, or with an AbortError as soon as `signal` aborts. The
 * browser still runs a queued delete the caller stopped waiting on.
 */
export function deleteIdb(
  factory: Pick<IDBFactory, 'deleteDatabase'>,
  name: string,
  { timeoutMs = DELETE_TIMEOUT_MS, signal, timers = realTimers }: Params = {},
): Promise<void> {
  return raceAbort({ signal, abortMessage: 'The database delete was aborted', start });

  function start(settle: Settle<void>): () => void {
    // Ends the timeout's wait, and with it its timer, once the race is over.
    const timeout = new AbortController();
    void withTimeout({
      work: requestDelete(factory, name),
      ms: timeoutMs,
      timeoutError: () =>
        new Error(`Failed to delete ${name} DB: still blocked by another connection after ${String(timeoutMs)}ms`),
      timers,
      signal: timeout.signal,
    }).then(settle.resolve, settle.reject);
    return () => {
      timeout.abort();
    };
  }
}

function requestDelete(factory: Pick<IDBFactory, 'deleteDatabase'>, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      // Only the cause keeps the DOMException's message for the report.
      const cause = request.error;
      reject(new Error(`Failed to delete ${name} DB: ${cause?.name ?? 'unknown'}`, cause ? { cause } : undefined));
    };
  });
}
