// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';

type Params<Value> = {
  /** How many values it hands on in one second at most. */
  perSecond: number;
  /** Takes each value it hands on. */
  onValue: (value: Value) => void;
  /** The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

/**
 * Hands a value on at once when none went out in the last interval of `1000 / perSecond` ms, and otherwise holds the
 * latest one until that interval ends, so a fast stream of readings reaches `onValue` at most `perSecond` times a
 * second and its last reading always arrives.
 */
export function createLatestLimiter<Value>({ perSecond, onValue, timers = realTimers }: Params<Value>) {
  const intervalMs = 1000 / perSecond;
  // The interval running since a value went out, with the latest value held for its end, or null when none runs. The
  // held value is boxed, so a value that is itself null is held too.
  let interval: { timer: unknown; held: { value: Value } | null } | null = null;

  return {
    /** Takes a value, handing it on now or at the end of the running interval in place of any value held before. */
    push,
    /** Drops a held value and ends the running interval. A value pushed later goes out at once. */
    stop,
  };

  function push(value: Value): void {
    if (interval !== null) {
      interval.held = { value };
      return;
    }
    handOn(value);
  }

  function stop(): void {
    if (interval !== null) {
      timers.clearTimeout(interval.timer);
    }
    interval = null;
  }

  // The interval starts before `onValue` runs, so a value it pushes back is held rather than handed on twice at once.
  function handOn(value: Value): void {
    interval = { timer: timers.setTimeout(endInterval, intervalMs), held: null };
    onValue(value);
  }

  function endInterval(): void {
    const held = interval?.held ?? null;
    interval = null;
    if (held !== null) {
      handOn(held.value);
    }
  }
}
