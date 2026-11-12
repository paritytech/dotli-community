// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's inbound byte total, reported for the host's speed readout from wherever the light client runs.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createListenerSet,
  createSharedRun,
  createStateMachine,
  type HandlerOf,
  type MachineTypes,
} from '@dotli/shared';

import { createIntervalTicker, type Ticker } from './createIntervalTicker.js';

const report = createReporter({ flow: 'protocol' });

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
};

/**
 * `failing` is a ticker whose last read threw, so the next throw is not reported again. A run of failures ends at a
 * good read or when the ticker stops.
 */
type MeterState =
  { kind: 'idle' } | { kind: 'ticking'; stopTicker: () => void } | { kind: 'failing'; stopTicker: () => void };

/** A tick reads the total itself, so the read's outcome arrives as the event. */
type MeterEvent =
  | { kind: 'tickerStarted'; stopTicker: () => void }
  | { kind: 'ticked'; total: number }
  | { kind: 'readFailed'; error: unknown }
  | { kind: 'tickerStopped' };

type MeterEffect =
  | { kind: 'posted'; total: number }
  | { kind: 'readFailed'; error: unknown }
  | { kind: 'tickerStopped'; stopTicker: () => void };

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
}: Params): (post: (total: number) => void) => () => void {
  const posts = createListenerSet<number>({ onListenerError: report.listener('protocol.net_bytes') });
  const stopTicking: HandlerOf<MeterMachine, 'ticking' | 'failing', 'tickerStopped'> = (
    { stopTicker },
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'idle' });
    emitSideEffect({ kind: 'tickerStopped', stopTicker });
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
        ticked(_state, { total }, { emitSideEffect }) {
          emitSideEffect({ kind: 'posted', total });
        },
        readFailed({ stopTicker }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'failing', stopTicker });
          emitSideEffect({ kind: 'readFailed', error });
        },
        tickerStopped: stopTicking,
      },
      // A read that throws again finds no handler. The run's first failure was reported, so a meter that stays broken
      // does not flood the log.
      failing: {
        ticked({ stopTicker }, { total }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ticking', stopTicker });
          emitSideEffect({ kind: 'posted', total });
        },
        tickerStopped: stopTicking,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'posted':
          posts.emit(effect.total);
          return;
        case 'readFailed':
          report.defect(effect.error, {
            step: 'net_bytes_read',
            metric: protocolNetBytesReadMetric,
            message: '[dot.li] The net bytes meter could not be read',
          });
          return;
        case 'tickerStopped':
          effect.stopTicker();
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: protocolNetBytesTransitionMetric,
        message: '[dot.li] A transition of the net bytes meter failed:',
      });
    },
  });
  // Rethrows a ticker that cannot start, so the subscribe that began it throws and leaves no run behind.
  const ticking = createSharedRun({
    begin: () => {
      meter.update({ kind: 'tickerStarted', stopTicker: startTicker(tick) });
      return () => {
        meter.update({ kind: 'tickerStopped' });
      };
    },
  });
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

  function tick(): void {
    // `update` never throws, so only the read is caught.
    try {
      meter.update({ kind: 'ticked', total: read() });
    } catch (error) {
      meter.update({ kind: 'readFailed', error });
    }
  }
}
