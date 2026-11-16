// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Calls `tick` once per interval until the returned stop runs. Throws when it cannot start. */
export type Ticker = (tick: () => void) => () => void;

/** A `Ticker` on a real interval of `intervalMs`. */
export function createIntervalTicker(intervalMs: number): Ticker {
  return startTicking;

  function startTicking(tick: () => void): () => void {
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }
}
