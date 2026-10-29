// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';
import type { DebugBusEvent, DotliDebugEvent } from '@dotli/truapi-debug';
import { pagePoll, type Poll } from './pagePoll.js';
import { readPageClock } from './readPageClock.js';

type Params = {
  /** The debug panel's flow for this page load. */
  flowId: string;
  emit: (event: DotliDebugEvent) => void;
  /** Sees the bus's events without taking the panel's boot replay. */
  watch: (callback: (event: DebugBusEvent) => void) => () => void;
  /** The clock the events are stamped with. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
  /** The monotonic clock stalls and uptime are measured on, in milliseconds. Defaults to the page's own. */
  now?: () => number;
  /** The tick the monitor checks the event loop on. The page's interval by default. */
  poll?: Poll;
};

const TICK_MS = 50;
const STALL_THRESHOLD_MS = 150;
const HEARTBEAT_INTERVAL_MS = 2_000;
const MAX_MONITOR_MS = 120_000;

/**
 * Reports event-loop stalls and a heartbeat to the debug panel, until the bridge handshakes or MAX_MONITOR_MS passes.
 * Returns the function that stops it early, with no report. Throws only as `watch` does, and the stop only as the
 * unsubscribe `watch` returned does.
 */
export function startMainThreadMonitor({
  flowId,
  emit,
  watch,
  timers = realTimers,
  now: readClock = readPageClock,
  poll = pagePoll,
}: Params): () => void {
  const startedAt = readClock();
  let lastTick = readClock();
  let lastHeartbeat = startedAt;

  function dispose(): void {
    stopPoll();
    stopWatching();
  }

  function stop(reason: 'bridge_ready' | 'max_duration'): void {
    dispose();
    emit({
      layer: 'main',
      event: 'monitor_stopped',
      flowId,
      timestamp: timers.now(),
      payload: { reason },
    });
  }

  const stopPoll = poll.start(() => {
    const now = readClock();
    const delta = now - lastTick;
    const lag = delta - TICK_MS;

    if (lag > STALL_THRESHOLD_MS) {
      emit({
        layer: 'main',
        event: 'stall_detected',
        flowId,
        timestamp: timers.now(),
        payload: { durationMs: Math.round(lag) },
      });
    }

    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      emit({
        layer: 'main',
        event: 'heartbeat',
        flowId,
        timestamp: timers.now(),
        payload: {
          uptimeSec: Math.round((now - startedAt) / 1000),
        },
      });
    }

    lastTick = now;

    if (now - startedAt > MAX_MONITOR_MS) {
      stop('max_duration');
    }
  }, TICK_MS);

  const stopWatching = watch(event => {
    if ('layer' in event && event.layer === 'bridge' && event.event === 'first_outbound') {
      stop('bridge_ready');
    }
  });

  return dispose;
}
