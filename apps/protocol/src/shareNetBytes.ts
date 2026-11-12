// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

import { createReporter, defineCount } from '@dotli/metrics';
import { createListenerSet, createStateMachine, type HandlerOf, type MachineTypes } from '@dotli/shared';

import { createIntervalTicker, type Ticker } from './createIntervalTicker.js';

const protocolReport = createReporter({ flow: 'protocol' });

/**
 * The light client's byte meter could not be read on a tick, so the speed readout misses that reading. Counted once per
 * run of failed reads. Tagged `outcome` (error) and `reason` (the error's name).
 */
const protocolNetBytesReadMetric = defineCount<'error'>('protocol.net_bytes_read');
const protocolNetBytesTransitionMetric = defineCount<'error'>('protocol.net_bytes.transition');

type Params = {
  /** Reads the light client's inbound byte total. */
  read: () => number;
  /** Runs the ticks while anyone listens. Defaults to a real interval of half a second. */
  startTicker?: Ticker | undefined;
  /** Hears a subscriber that throws, so the others still hear the tick. */
  report?: (error: unknown) => void;
  /**
   * Hears the first read that throws on a tick after a good one, so a meter that stays broken is reported once. A run
   * of failures ends at a good read or when the ticker stops.
   */
  reportRead?: (error: unknown) => void;
};

/** `failing` is a ticker whose last read threw, so the next throw is not reported again. */
type MeterState =
  { kind: 'idle' } | { kind: 'ticking'; stopTicker: () => void } | { kind: 'failing'; stopTicker: () => void };

/** A tick reads the total itself, so the read's outcome arrives as the event. */
type MeterEvent =
  | { kind: 'tickerStarted'; stopTicker: () => void }
  | { kind: 'ticked'; total: number }
  | { kind: 'readFailed'; error: unknown }
  | { kind: 'lastLeft' };

type MeterEffect = { kind: 'readFailed'; error: unknown };

type MeterMachine = MachineTypes<MeterState, MeterEvent, MeterEffect>;

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
  report = protocolReport.listener('protocol.net_bytes'),
  reportRead = error => {
    protocolReport.defect(error, {
      step: 'net_bytes_read',
      metric: protocolNetBytesReadMetric,
      message: '[dot.li] The net bytes meter could not be read',
    });
  },
}: Params): (post: (total: number) => void) => () => void {
  const posts = createListenerSet<number>({ onListenerError: report });
  const stopTicking: HandlerOf<MeterMachine, 'ticking' | 'failing', 'lastLeft'> = (
    { stopTicker },
    _event,
    { emitState },
  ) => {
    // A tab that subscribed while this event waited behind a tick keeps the ticker.
    if (posts.size > 0) {
      return;
    }
    emitState({ kind: 'idle' });
    stopTicker();
  };
  const meter = createStateMachine<MeterMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        tickerStarted(_state, { stopTicker }, { emitState }) {
          emitState({ kind: 'ticking', stopTicker });
        },
      },
      ticking: {
        ticked(_state, { total }) {
          posts.emit(total);
        },
        readFailed({ stopTicker }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'failing', stopTicker });
          emitSideEffect({ kind: 'readFailed', error });
        },
        lastLeft: stopTicking,
      },
      // A read that throws again finds no handler. The run's first failure was reported, so a meter that stays broken
      // does not flood the log.
      failing: {
        ticked({ stopTicker }, { total }, { emitState }) {
          emitState({ kind: 'ticking', stopTicker });
          posts.emit(total);
        },
        lastLeft: stopTicking,
      },
    },
    onEffect: ({ error }) => {
      reportRead(error);
    },
    onError: error => {
      protocolReport.defect(error, {
        step: 'transition',
        metric: protocolNetBytesTransitionMetric,
        message: '[dot.li] A transition of the net bytes meter failed:',
      });
    },
  });
  return subscribe;

  function subscribe(post: (total: number) => void): () => void {
    // Read first, so a subscribe that throws leaves nothing behind.
    const baseline = read();
    const unsubscribe = posts.subscribe(post);
    if (meter.state.get().kind === 'idle') {
      let stopTicker: () => void;
      try {
        stopTicker = startTicker(tick);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      meter.update({ kind: 'tickerStarted', stopTicker });
    }
    posts.deliver(post, baseline);
    return stop;

    function stop(): void {
      unsubscribe();
      if (posts.size === 0) {
        meter.update({ kind: 'lastLeft' });
      }
    }
  }

  function tick(): void {
    let total: number;
    try {
      total = read();
    } catch (error) {
      meter.update({ kind: 'readFailed', error });
      return;
    }
    meter.update({ kind: 'ticked', total });
  }
}
