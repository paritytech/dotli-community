// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Timers } from '../realTimers.js';

/** Timers a spec moves by hand, so a wait is a step the test takes rather than time it spends. */
export type ManualTimers = ReturnType<typeof createManualTimers>;

type Params = {
  start?: number;
};

type Scheduled = {
  at: number;
  callback: () => void;
};

/** A clock and timers that move only when a spec calls `advance` or `freeze`. */
export function createManualTimers({ start = 0 }: Params = {}) {
  let clock = start;
  let nextHandle = 1;
  const scheduled = new Map<number, Scheduled>();

  const timers = { now, setTimeout, clearTimeout } satisfies Timers;

  return {
    ...timers,
    /** Moves the clock `ms` on, firing each timer as it falls due, in order, and letting the work it starts settle. */
    advance,
    /**
     * The page frozen for `ms`: the clock moves on and nothing fires, so each timer due meanwhile fires late on the next
     * `advance`.
     */
    freeze,
    /** How many timers are scheduled and have neither fired nor been cleared. */
    countPending,
  };

  function now(): number {
    return clock;
  }

  function setTimeout(callback: () => void, ms: number): number {
    const handle = nextHandle;
    nextHandle += 1;
    scheduled.set(handle, { at: clock + Math.max(0, ms), callback });
    return handle;
  }

  function clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      scheduled.delete(handle);
    }
  }

  async function advance(ms: number): Promise<void> {
    const until = clock + ms;
    await settle();
    for (let due = findNextDue(until); due !== undefined; due = findNextDue(until)) {
      const [handle, { at, callback }] = due;
      scheduled.delete(handle);
      // A timer that fell due while frozen fires now, late, as a page that wakes up fires it.
      clock = Math.max(clock, at);
      callback();
      await settle();
    }
    clock = until;
  }

  function freeze(ms: number): void {
    clock += ms;
  }

  function countPending(): number {
    return scheduled.size;
  }

  /** The earliest timer due by `until`, the first scheduled among equals. */
  function findNextDue(until: number): [number, Scheduled] | undefined {
    let next: [number, Scheduled] | undefined;
    for (const entry of scheduled) {
      if (entry[1].at <= until && (next === undefined || entry[1].at < next[1].at)) {
        next = entry;
      }
    }
    return next;
  }
}

/** One turn of the real event loop, so every promise the last step started settles before the next step. */
function settle(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}
