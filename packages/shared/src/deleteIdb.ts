// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from './realTimers.js';
import { withTimeout } from './withTimeout.js';

type Params = {
  timeoutMs?: number;
  timers?: Timers;
};

/** Long enough for another tab to close its connection, short enough that a stuck one does not hold up init. */
const DELETE_TIMEOUT_MS = 3_000;

/**
 * Deletes `name`. A delete an open connection blocks stays queued in the browser and runs once that connection closes,
 * so it waits for that, rejecting if `timeoutMs` pass first. The browser still runs a queued delete the caller stopped
 * waiting on.
 */
export function deleteIdb(
  factory: Pick<IDBFactory, 'deleteDatabase'>,
  name: string,
  { timeoutMs = DELETE_TIMEOUT_MS, timers = realTimers }: Params = {},
): Promise<void> {
  return withTimeout({
    work: requestDelete(factory, name),
    ms: timeoutMs,
    timeoutError: () =>
      new Error(`Failed to delete ${name} DB: still blocked by another connection after ${String(timeoutMs)}ms`),
    timers,
  });
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
