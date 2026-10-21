// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Timers } from '../timers.js';

/** Timers a spec moves by hand, so a wait is a step the test takes rather than time it spends. */
export interface ManualTimers extends Timers {
  /** Moves the clock `ms` on, firing each timer as it falls due, in order, and letting the work it starts settle. */
  advance: (ms: number) => Promise<void>;
  /**
   * The page frozen for `ms`: the clock moves on and nothing fires, so each timer due meanwhile fires late on the next
   * `advance`.
   */
  freeze: (ms: number) => void;
  /** How many timers are scheduled and have neither fired nor been cleared. */
  pending: () => number;
}

interface Scheduled {
  at: number;
  callback: () => void;
}

/** One turn of the real event loop, so every promise the last step started settles before the next step. */
function settle(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

export function manualTimers(start = 0): ManualTimers {
  let now = start;
  let nextHandle = 1;
  const scheduled = new Map<number, Scheduled>();

  /** The earliest timer due by `until`, the first scheduled among equals. */
  function nextDue(until: number): [number, Scheduled] | undefined {
    let next: [number, Scheduled] | undefined;
    for (const entry of scheduled) {
      if (entry[1].at <= until && (next === undefined || entry[1].at < next[1].at)) {
        next = entry;
      }
    }
    return next;
  }

  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.set(handle, { at: now + Math.max(0, ms), callback });
      return handle;
    },
    clearTimeout: handle => {
      if (typeof handle === 'number') {
        scheduled.delete(handle);
      }
    },
    advance: async ms => {
      const until = now + ms;
      await settle();
      for (let due = nextDue(until); due !== undefined; due = nextDue(until)) {
        const [handle, { at, callback }] = due;
        scheduled.delete(handle);
        // A timer that fell due while frozen fires now, late, as a page that wakes up fires it.
        now = Math.max(now, at);
        callback();
        await settle();
      }
      now = until;
    },
    freeze: ms => {
      now += ms;
    },
    pending: () => scheduled.size,
  };
}
