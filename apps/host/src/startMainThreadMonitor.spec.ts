// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import { debugBus, type DotliDebugEvent } from '@dotli/truapi-debug';

import { startMainThreadMonitor } from './startMainThreadMonitor.js';
import { createManualPoll } from './testing/createManualPoll.js';

/** A monitor on the real bus over one manual clock, and what it emitted. */
type MonitorStand = {
  timers: ManualTimers;
  emitted: DotliDebugEvent[];
  dispose: () => void;
  /** Emits what the bridge emits on its first message to the product. */
  emitBridgeFirstOutbound: () => void;
};

describe('main-thread monitor', () => {
  it('As a developer watching the debug panel, I see the bridge first answer the product and the boot monitor stops', () => {
    // Given
    const { emitted, timers, emitBridgeFirstOutbound } = startMonitor();

    // When
    emitBridgeFirstOutbound();

    // Then
    expect(getStops(emitted)).toEqual([{ reason: 'bridge_ready' }]);
    expect(timers.countPending()).toBe(0);
  });

  it('As a developer watching the debug panel, I wait two minutes and the boot monitor gives up while a later bridge answer adds nothing', async () => {
    // Given
    const { emitted, timers, emitBridgeFirstOutbound } = startMonitor();

    // When the next tick comes two minutes on, frozen rather than ticked through since 2,400 manual ticks take seconds,
    // and the bridge answers after
    timers.freeze(120_050);
    await timers.advance(50);
    emitBridgeFirstOutbound();

    // Then
    expect(getStops(emitted)).toEqual([{ reason: 'max_duration' }]);
    expect(timers.countPending()).toBe(0);
  });

  it('As a developer watching the debug panel, I dispose the boot monitor and it checks nothing more and reports nothing when the bridge answers', () => {
    // Given
    const { emitted, timers, dispose, emitBridgeFirstOutbound } = startMonitor();

    // When
    dispose();
    emitBridgeFirstOutbound();

    // Then
    expect(getStops(emitted)).toEqual([]);
    expect(timers.countPending()).toBe(0);
  });
});

/** Starts the monitor on the real bus over fresh timers, keeping what it emits. */
function startMonitor(): MonitorStand {
  const timers = createManualTimers();
  // As the host turns the bus on once debug mode is on.
  debugBus.enableBuffering();
  const emitted: DotliDebugEvent[] = [];
  const dispose = startMainThreadMonitor({
    flowId: 'boot-flow',
    emit(event) {
      emitted.push(event);
    },
    watch: debugBus.watch,
    timers,
    now: timers.now,
    poll: createManualPoll({ timers }),
  });
  return {
    timers,
    emitted,
    dispose,
    emitBridgeFirstOutbound() {
      debugBus.emit({
        layer: 'bridge',
        event: 'first_outbound',
        flowId: 'bridge-flow',
        timestamp: timers.now(),
        payload: { label: 'doom', productId: 'doom' },
      });
    },
  };
}

function getStops(emitted: DotliDebugEvent[]): unknown[] {
  return emitted.filter(event => event.event === 'monitor_stopped').map(event => event.payload);
}
