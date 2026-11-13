// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

import { createReporter, defineCount } from '@dotli/metrics';
import { createListenerSet, createSharedRun } from '@dotli/shared';

import { createIntervalTicker, type Ticker } from './createIntervalTicker.js';

const report = createReporter({ flow: 'protocol' });

/**
 * The light client's byte meter could not be read on a tick, so the speed readout misses that reading. Counted once per
 * run of failed reads. Tagged `outcome` (error) and `reason` (the error's name).
 */
const protocolNetBytesReadMetric = defineCount<'error'>('protocol.net_bytes_read');
/** The meter's ticker threw as it stopped, so it may still tick. Tagged `outcome` (error) and `reason`. */
const protocolNetBytesStopMetric = defineCount<'error'>('protocol.net_bytes_stop');

type Params = {
  /** Reads the light client's inbound byte total. */
  read: () => number;
  /** Runs the ticks while anyone listens. Defaults to a real interval of half a second. */
  startTicker?: Ticker | undefined;
};

/**
 * One meter for every subscriber, so a worker that serves many tabs runs one ticker however many listen. The ticker
 * runs while anyone listens. Each subscriber hears the total at once, as the baseline a rate needs, then on every
 * tick. Cumulative, so a dropped message only widens one window. A subscribe that throws leaves nothing behind, and a
 * tick whose read throws is skipped.
 */
export function shareNetBytes({
  read,
  // How often the total is reported.
  startTicker = createIntervalTicker(500),
}: Params): (post: (total: number) => void) => () => void {
  const posts = createListenerSet<number>({ onListenerError: report.listener('protocol.net_bytes') });
  // Rethrows a ticker that cannot start, so the subscribe that began it throws and leaves no run behind.
  const ticking = createSharedRun({ begin: startRun });
  return subscribe;

  function subscribe(post: (total: number) => void): () => void {
    // Read first, so a subscribe that throws leaves nothing behind.
    const baseline = read();
    const leave = ticking.join();
    const unsubscribe = posts.subscribe(post);
    posts.deliver(post, baseline);
    return () => {
      unsubscribe();
      leave();
    };
  }

  function startRun(): () => void {
    // Whether the last read threw, so a meter that stays broken is reported once per run of failures, not per tick.
    let failing = false;
    const stopTicker = startTicker(tick);
    // Reported, not thrown, so the tab whose leave ended the run does not hear the ticker's failure.
    return () => {
      try {
        stopTicker();
      } catch (error) {
        report.defect(error, {
          step: 'net_bytes_stop',
          metric: protocolNetBytesStopMetric,
          message: '[dot.li] The net bytes ticker could not be stopped',
        });
      }
    };

    function tick(): void {
      let total: number;
      try {
        total = read();
      } catch (error) {
        if (!failing) {
          failing = true;
          report.defect(error, {
            step: 'net_bytes_read',
            metric: protocolNetBytesReadMetric,
            message: '[dot.li] The net bytes meter could not be read',
          });
        }
        return;
      }
      failing = false;
      posts.emit(total);
    }
  }
}
