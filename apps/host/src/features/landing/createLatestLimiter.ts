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

// Idle until a value goes out. Then open while its interval runs, or holding once a later value waits for the end.
type LimiterState<Value> =
  { kind: 'idle' } | { kind: 'open'; timer: unknown } | { kind: 'holding'; timer: unknown; value: Value };

/**
 * Hands a value on at once when none went out in the last interval of `1000 / perSecond` ms, and otherwise holds the
 * latest one until that interval ends, so a fast stream of readings reaches `onValue` at most `perSecond` times a
 * second and its last reading always arrives.
 */
export function createLatestLimiter<Value>({ perSecond, onValue, timers = realTimers }: Params<Value>) {
  const intervalMs = 1000 / perSecond;
  let state: LimiterState<Value> = { kind: 'idle' };

  return {
    /** Takes a value, handing it on now or at the end of the running interval in place of any value held before. */
    push,
    /** Drops a held value and ends the running interval. A value pushed later goes out at once. */
    stop,
  };

  function push(value: Value): void {
    if (state.kind === 'idle') {
      handOn(value);
      return;
    }
    state = { kind: 'holding', timer: state.timer, value };
  }

  function stop(): void {
    if (state.kind !== 'idle') {
      timers.clearTimeout(state.timer);
    }
    state = { kind: 'idle' };
  }

  // The interval opens before `onValue` runs, so a value it pushes back is held rather than handed on twice at once.
  function handOn(value: Value): void {
    state = { kind: 'open', timer: timers.setTimeout(endInterval, intervalMs) };
    onValue(value);
  }

  function endInterval(): void {
    const ended = state;
    state = { kind: 'idle' };
    if (ended.kind === 'holding') {
      handOn(ended.value);
    }
  }
}
