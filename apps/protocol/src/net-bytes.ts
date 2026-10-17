// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';

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

export interface ShareNetBytesOptions {
  /** Hears a subscriber that throws, so the others still hear the tick. */
  report?: (error: unknown) => void;
  /** Hears the first read that throws on a tick after a good one, so a meter that stays broken is reported once. */
  reportRead?: (error: unknown) => void;
}

function reportFailedRead(error: unknown): void {
  captureException(error, { flow: 'protocol', step: 'net_bytes_read' });
  log.error('[dot.li] The net bytes meter could not be read', error);
  m.count(S.PROTOCOL_NET_BYTES_READ, { outcome: 'error', reason: errorName(error) ?? 'unknown' });
}

/**
 * One meter for every subscriber, so a worker that serves many tabs runs one ticker however many listen. The ticker
 * runs while anyone listens. Each subscriber hears the total at once, as the baseline a rate needs, then on every
 * tick. Cumulative, so the host owns the averaging and a dropped message only widens one window. A subscribe that
 * throws leaves nothing behind, and a tick whose read throws is skipped.
 */
export function shareNetBytes(
  read: () => number,
  ticker: Ticker,
  options: ShareNetBytesOptions = {},
): (post: (total: number) => void) => () => void {
  const report = options.report ?? reportListener('protocol', 'protocol.net_bytes');
  const reportRead = options.reportRead ?? reportFailedRead;
  // Whether the last tick's read failed, so a run of failures is reported once and a good read rearms the report.
  let readFailing = false;
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
      if (!readFailing) {
        readFailing = true;
        reportRead(error);
      }
      return;
    }
    readFailing = false;
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
