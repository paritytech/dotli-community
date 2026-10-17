// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

/** How often the total is reported. The host averages over these readings. */
export const NET_BYTES_INTERVAL_MS = 500;

/** Calls `tick` once per interval until the returned stop runs. */
export type Ticker = (tick: () => void) => () => void;

/** A `Ticker` on a real interval of `intervalMs`. */
export function intervalTicker(intervalMs: number): Ticker {
  return tick => {
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearInterval(timer);
    };
  };
}

/**
 * Reports the total now, as the baseline a rate needs, then on every tick. Cumulative, so the host owns the averaging
 * and a dropped message only widens one window.
 */
export function reportNetBytes(read: () => number, post: (total: number) => void, ticker: Ticker): () => void {
  const report = (): void => {
    post(read());
  };
  report();
  return ticker(report);
}
