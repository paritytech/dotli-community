// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The clock and timers a module waits on, passed in so a spec moves time itself instead of faking the globals. */
export interface Timers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The page's own clock and timers, read at each call so a spec that fakes the globals still reaches them. */
export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout> | undefined);
  },
};
