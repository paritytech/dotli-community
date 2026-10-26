// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import { createListenerSet, errorName, log } from '@dotli/shared';

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

export type ShareNetBytesOptions = {
  /** Hears a subscriber that throws, so the others still hear the tick. */
  report?: (error: unknown) => void;
  /** Hears the first read that throws on a tick after a good one, so a meter that stays broken is reported once. */
  reportRead?: (error: unknown) => void;
};

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
  const reportRead = options.reportRead ?? reportFailedRead;
  // Whether the last tick's read failed, so a run of failures is reported once and a good read rearms the report.
  let readFailing = false;
  const posts = createListenerSet<number>({
    onListenerError: options.report ?? reportListener('protocol', 'protocol.net_bytes'),
  });
  let stopTicker: (() => void) | null = null;
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
    posts.emit(total);
  };
  return post => {
    // Read first, so a subscribe that throws leaves nothing behind.
    const baseline = read();
    const unsubscribe = posts.subscribe(post);
    if (stopTicker === null) {
      try {
        stopTicker = ticker(tick);
      } catch (error) {
        unsubscribe();
        throw error;
      }
    }
    posts.deliver(post, baseline);
    return () => {
      unsubscribe();
      if (posts.size === 0) {
        stopTicker?.();
        stopTicker = null;
      }
    };
  };
}
