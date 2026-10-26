// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliDebugBusEvent, DotliDebugEvent } from '@dotli/truapi-debug';

export type MainThreadMonitorBus = {
  emit: (event: DotliDebugEvent) => void;
  /** Sees the bus's events without taking the panel's boot replay. */
  watch: (callback: (event: DotliDebugBusEvent) => void) => () => void;
};

/** Event-loop stalls and a heartbeat for the debug panel, until the bridge handshakes or MAX_MONITOR_MS passes. */
export function startMainThreadMonitor(flowId: string, { emit, watch }: MainThreadMonitorBus): void {
  const TICK_MS = 50;
  const STALL_THRESHOLD_MS = 150;
  const HEARTBEAT_INTERVAL_MS = 2_000;
  const MAX_MONITOR_MS = 120_000;

  const startedAt = performance.now();
  let lastTick = performance.now();
  let lastHeartbeat = startedAt;

  const stop = (reason: 'bridge_ready' | 'max_duration'): void => {
    clearInterval(handle);
    stopWatching();
    emit({
      layer: 'main',
      event: 'monitor_stopped',
      flowId,
      timestamp: Date.now(),
      payload: { reason },
    });
  };

  const handle = setInterval(() => {
    const now = performance.now();
    const delta = now - lastTick;
    const lag = delta - TICK_MS;

    if (lag > STALL_THRESHOLD_MS) {
      emit({
        layer: 'main',
        event: 'stall_detected',
        flowId,
        timestamp: Date.now(),
        payload: { durationMs: Math.round(lag) },
      });
    }

    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      emit({
        layer: 'main',
        event: 'heartbeat',
        flowId,
        timestamp: Date.now(),
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
}
