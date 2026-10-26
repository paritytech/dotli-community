// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The clock and timers a module waits on, passed in so a spec moves time itself instead of faking the globals. */
export type Timers = {
  /** The current time in milliseconds. Never throws. */
  now(): number;
  /** Calls `callback` once after `ms` and returns the handle that cancels it. Never throws. */
  setTimeout(callback: () => void, ms: number): unknown;
  /** Cancels the timer `handle` names. A handle whose timer has run or was cleared already does nothing. */
  clearTimeout(handle: unknown): void;
};

/** The page's own clock and timers, read at each call so a spec that fakes the globals still reaches them. */
export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => {
    // The handle is one this object's `setTimeout` returned, typed `unknown` only so a fake may use its own.
    clearTimeout(handle as ReturnType<typeof setTimeout> | undefined);
  },
};
