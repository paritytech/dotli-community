// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';

// A control shows an outcome for a moment, such as Copied. The outcome often lands in a promise after the control is
// gone, so the timer has one owner that the control disposes, and a late outcome writes nothing.

/** A value a control shows for a moment. */
export type Flash<T> = ReturnType<typeof createFlash<T>>;

type Params<T> = {
  /** How long a value shows, in milliseconds. */
  durationMs: number;
  /** The value to show, or `null` when the moment is over. */
  onChange: (value: T | null) => void;
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'> | undefined;
};

/** Shows each value for `durationMs`, then reports `null`. */
export function createFlash<T>({ durationMs, onChange, timers = realTimers }: Params<T>) {
  // The timer of the value showing, or null when none shows.
  let handle: unknown = null;
  let disposed = false;

  return {
    /** Shows `value` for the flash time, in place of any value showing. Does nothing once disposed. */
    show,
    /** Cancels the timer. Later shows do nothing. */
    dispose,
  };

  function show(value: T): void {
    if (disposed) {
      return;
    }
    cancel();
    onChange(value);
    handle = timers.setTimeout(() => {
      handle = null;
      onChange(null);
    }, durationMs);
  }

  function dispose(): void {
    disposed = true;
    cancel();
  }

  function cancel(): void {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
  }
}
