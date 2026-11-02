// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { raceAbort, type Settle } from './raceAbort.js';
import { realTimers, type Timers } from './realTimers.js';

type Params = {
  signal?: AbortSignal;
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

/** Resolves after `ms`, or rejects with `signal.reason` as soon as `signal` aborts, clearing its timer. */
export function sleep(ms: number, { signal, timers = realTimers }: Params = {}): Promise<void> {
  return raceAbort({ signal, start });

  function start(settle: Settle<void>): () => void {
    const timer = timers.setTimeout(() => {
      settle.resolve();
    }, ms);
    return () => {
      timers.clearTimeout(timer);
    };
  }
}
