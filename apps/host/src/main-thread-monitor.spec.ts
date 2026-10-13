// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDotliDebugBus, type DotliDebugEvent } from '@dotli/truapi-debug';

import { startMainThreadMonitor } from './main-thread-monitor.js';

let bus: Awaited<ReturnType<typeof loadDotliDebugBus>>;

/** What the bridge emits on its first message to the product. */
function bridgeFirstOutbound(): void {
  bus.emitDotliDebugEvent({
    layer: 'bridge',
    event: 'first_outbound',
    flowId: 'bridge-flow',
    timestamp: Date.now(),
    payload: { label: 'doom', productId: 'doom' },
  });
}

/** Starts the monitor on the real bus, keeping what it emits. */
function startMonitor(): DotliDebugEvent[] {
  const emitted: DotliDebugEvent[] = [];
  startMainThreadMonitor('boot-flow', {
    emit: event => {
      emitted.push(event);
    },
    watch: bus.watchDotliDebugEvents,
  });
  return emitted;
}

function stops(emitted: DotliDebugEvent[]): unknown[] {
  return emitted.filter(event => event.event === 'monitor_stopped').map(event => event.payload);
}

beforeEach(async () => {
  vi.useFakeTimers();
  // As the host loads the bus and turns it on once debug mode is on.
  bus = await loadDotliDebugBus();
  bus.enableDotliDebugBuffering();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('main-thread monitor', () => {
  it('As a developer watching the debug panel, the boot monitor stops once the bridge first answers the product', () => {
    // Given
    const emitted = startMonitor();

    // When
    bridgeFirstOutbound();

    // Then
    expect(stops(emitted)).toEqual([{ reason: 'bridge_ready' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a developer watching the debug panel, the boot monitor gives up after two minutes and a later bridge answer adds nothing', () => {
    // Given
    const emitted = startMonitor();
    vi.advanceTimersByTime(120_100);

    // When
    bridgeFirstOutbound();

    // Then
    expect(stops(emitted)).toEqual([{ reason: 'max_duration' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
