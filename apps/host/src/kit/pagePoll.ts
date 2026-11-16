// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A repeating tick, passed in so a spec moves it on its own clock instead of faking the page's interval. */
export type Poll = {
  /**
   * Calls `tick` every `intervalMs` and returns the function that stops it. Never throws, and stopping a poll already
   * stopped does nothing.
   */
  start(tick: () => void, intervalMs: number): () => void;
};

/** The page's own interval, read at each call so a spec that fakes the globals still reaches it. */
export const pagePoll: Poll = {
  start(tick, intervalMs) {
    const interval = setInterval(tick, intervalMs);
    return stop;

    function stop(): void {
      clearInterval(interval);
    }
  },
};
