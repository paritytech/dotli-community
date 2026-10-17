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
 * tick. Cumulative, so the host owns the averaging and a dropped message only widens one window. `report` hears a
 * subscriber that throws, so the others still hear the tick.
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
    const total = read();
    for (const post of [...posts]) {
      tell(post, total);
    }
  };
  return post => {
    // Wrapped so one listener subscribed twice is two subscribers.
    const subscriber = (total: number): void => {
      post(total);
    };
    posts.add(subscriber);
    stopTicker ??= ticker(tick);
    tell(subscriber, read());
    return () => {
      if (!posts.delete(subscriber) || posts.size > 0) {
        return;
      }
      stopTicker?.();
      stopTicker = null;
    };
  };
}
