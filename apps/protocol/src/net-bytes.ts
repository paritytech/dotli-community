// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

import { reportListener } from '@dotli/metrics';

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
 * One meter for every subscriber, so a worker that serves many tabs runs one ticker however many listen. The ticker
 * runs while anyone listens. Each subscriber hears the total at once, as the baseline a rate needs, then on every
 * tick. Cumulative, so the host owns the averaging and a dropped message only widens one window. A subscribe that
 * throws leaves nothing behind. `report` hears a subscriber or a tick's read that throws, so the ticker carries on.
 */
export function shareNetBytes(
  read: () => number,
  ticker: Ticker,
  report: (error: unknown) => void = reportListener('protocol', 'protocol.net_bytes'),
): (post: (total: number) => void) => () => void {
  const posts = new Set<(total: number) => void>();
  let stopTicker: (() => void) | null = null;
  const tell = (post: (total: number) => void, total: number): void => {
    try {
      post(total);
    } catch (error) {
      report(error);
    }
  };
  const tick = (): void => {
    let total: number;
    try {
      total = read();
    } catch (error) {
      // Thrown from an interval, nothing above would hear it.
      report(error);
      return;
    }
    for (const post of [...posts]) {
      tell(post, total);
    }
  };
  return post => {
    // Read first, so a subscribe that throws leaves nothing behind.
    const baseline = read();
    // Wrapped so one listener subscribed twice is two subscribers.
    const subscriber = (total: number): void => {
      post(total);
    };
    posts.add(subscriber);
    if (stopTicker === null) {
      try {
        stopTicker = ticker(tick);
      } catch (error) {
        posts.delete(subscriber);
        throw error;
      }
    }
    tell(subscriber, baseline);
    return () => {
      if (!posts.delete(subscriber) || posts.size > 0) {
        return;
      }
      stopTicker?.();
      stopTicker = null;
    };
  };
}
