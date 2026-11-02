// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

import { reportDefect, reportListener, spans as S } from '@dotli/metrics';
import { createListenerSet } from '@dotli/shared';

import { createIntervalTicker, type Ticker } from './createIntervalTicker.js';

type Params = {
  /** Reads the light client's inbound byte total. */
  read: () => number;
  /** Runs the ticks while anyone listens. Defaults to a real interval of `NET_BYTES_INTERVAL_MS`. */
  startTicker?: Ticker | undefined;
  /** Hears a subscriber that throws, so the others still hear the tick. */
  report?: (error: unknown) => void;
  /** Hears the first read that throws on a tick after a good one, so a meter that stays broken is reported once. */
  reportRead?: (error: unknown) => void;
};

/** How often the total is reported. */
const NET_BYTES_INTERVAL_MS = 500;

/**
 * One meter for every subscriber, so a worker that serves many tabs runs one ticker however many listen. The ticker
 * runs while anyone listens. Each subscriber hears the total at once, as the baseline a rate needs, then on every
 * tick. Cumulative, so a dropped message only widens one window. A subscribe that throws leaves nothing behind, and a
 * tick whose read throws is skipped.
 */
export function shareNetBytes({
  read,
  startTicker = createIntervalTicker(NET_BYTES_INTERVAL_MS),
  report = reportListener('protocol', 'protocol.net_bytes'),
  reportRead = reportFailedRead,
}: Params): (post: (total: number) => void) => () => void {
  // Whether the last tick's read failed, so a run of failures is reported once and a good read rearms the report.
  let readFailing = false;
  const posts = createListenerSet<number>({ onListenerError: report });
  let stopTicker: (() => void) | null = null;
  return subscribe;

  function subscribe(post: (total: number) => void): () => void {
    // Read first, so a subscribe that throws leaves nothing behind.
    const baseline = read();
    const unsubscribe = posts.subscribe(post);
    if (stopTicker === null) {
      try {
        stopTicker = startTicker(tick);
      } catch (error) {
        unsubscribe();
        throw error;
      }
    }
    posts.deliver(post, baseline);
    return stop;

    function stop(): void {
      unsubscribe();
      if (posts.size === 0) {
        stopTicker?.();
        stopTicker = null;
      }
    }
  }

  function tick(): void {
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
  }
}

function reportFailedRead(error: unknown): void {
  reportDefect(error, {
    flow: 'protocol',
    step: 'net_bytes_read',
    metric: S.PROTOCOL_NET_BYTES_READ,
    message: '[dot.li] The net bytes meter could not be read',
  });
}
