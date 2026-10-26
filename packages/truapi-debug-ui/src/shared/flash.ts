// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';

// A control shows an outcome for a moment, such as Copied. The outcome often lands in a promise after the control is
// gone, so the timer has one owner that the control disposes, and a late outcome writes nothing.

export type Flash<T> = {
  /** Shows `value` for the flash time, in place of any value showing. Does nothing once disposed. */
  show: (value: T) => void;
  /** Cancels the timer. Later shows do nothing. */
  dispose: () => void;
};

export function createFlash<T>(options: {
  ms: number;
  /** The value to show, or `null` when the moment is over. */
  onChange: (value: T | null) => void;
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'> | undefined;
}): Flash<T> {
  const timers = options.timers ?? realTimers;
  let handle: unknown;
  let waiting = false;
  let disposed = false;
  const cancel = (): void => {
    if (waiting) {
      timers.clearTimeout(handle);
      waiting = false;
    }
  };
  return {
    show: value => {
      if (disposed) {
        return;
      }
      cancel();
      options.onChange(value);
      waiting = true;
      handle = timers.setTimeout(() => {
        waiting = false;
        options.onChange(null);
      }, options.ms);
    },
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}
