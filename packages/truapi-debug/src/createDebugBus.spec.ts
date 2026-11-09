// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindLogSink } from '@dotli/shared';
import { catchError } from '@dotli/shared/testing';
import { createDebugBus, type DebugBus, type DebugBusEvent } from './createDebugBus.js';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';

/** Record the captures, error lines and metrics a throwing listener leaves, until the test ends. */
function recordListenerReports() {
  const captured = recordReports({ onFinished: onTestFinished }).exceptions;
  const errors: string[] = [];
  onTestFinished(
    bindLogSink({
      emit: ({ level, message }) => {
        if (level === 'error') {
          errors.push(message);
        }
      },
    }),
  );
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { captured, errors, listDeliveryMetrics: () => metrics.counted('listener.delivery') };
}

function createEnabledBus(): DebugBus {
  const bus = createDebugBus();
  bus.enableBuffering();
  return bus;
}

function createBootEvent(flowId: string): DebugBusEvent {
  return {
    layer: 'boot',
    event: 'started',
    flowId,
    timestamp: 0,
    payload: { chainBackend: 'smoldot', skipCidCache: false, skipArchiveCache: false },
  };
}

describe('debug bus listener failures', () => {
  it('As a dotli developer, I emit an event past a host watcher that throws and the throw is reported while the next watcher and the panel still get the event', () => {
    // Given a watcher that throws on every event, a watcher after it and a mounted panel
    const reports = recordListenerReports();
    const bus = createEnabledBus();
    bus.watch(() => {
      throw new TypeError('watcher broke');
    });
    const watched: DebugBusEvent[] = [];
    bus.watch(event => watched.push(event));
    const shown: DebugBusEvent[] = [];
    bus.subscribe(event => shown.push(event));

    // When an event is emitted
    bus.emit(createBootEvent('flow-1'));

    // Then both later receivers got it, and the throw was reported once
    expect(watched).toEqual([createBootEvent('flow-1')]);
    expect(shown).toEqual([createBootEvent('flow-1')]);
    expect(reports.captured).toMatchObject([{ step: 'listener', tags: { owner: 'debug_bus.watch' } }]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.listDeliveryMetrics()).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'debug_bus.watch' },
    ]);
  });

  it('As a dotli developer, I open a panel that throws on a replayed boot event and the throw is reported while the panel still gets the rest of the replay', () => {
    // Given two boot events buffered before the panel loads
    const reports = recordListenerReports();
    const bus = createEnabledBus();
    bus.emit(createBootEvent('flow-1'));
    bus.emit(createBootEvent('flow-2'));

    // When the panel subscribes and throws on the first replayed event
    const shown: DebugBusEvent[] = [];
    bus.subscribe(event => {
      if (shown.length === 0) {
        shown.push(event);
        throw new RangeError('panel broke');
      }
      shown.push(event);
    });

    // Then it still got the second, and the throw was reported once
    expect(shown).toEqual([createBootEvent('flow-1'), createBootEvent('flow-2')]);
    expect(reports.captured).toMatchObject([{ step: 'listener', tags: { owner: 'debug_bus.replay' } }]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.listDeliveryMetrics()).toEqual([
      { outcome: 'error', reason: 'RangeError', owner: 'debug_bus.replay' },
    ]);
  });

  it('As a dotli developer, I emit an event past a panel that throws and the throw is reported while the next panel still gets it and the emitter goes on', () => {
    // Given a mounted panel that throws, and one after it
    const reports = recordListenerReports();
    const bus = createEnabledBus();
    bus.subscribe(() => {
      throw new TypeError('panel broke');
    });
    const shown: DebugBusEvent[] = [];
    bus.subscribe(event => shown.push(event));

    // When the host emits
    const thrown = catchError(() => {
      bus.emit(createBootEvent('flow-1'));
    });

    // Then
    expect(thrown).toBeUndefined();
    expect(shown).toEqual([createBootEvent('flow-1')]);
    expect(reports.captured).toMatchObject([{ step: 'listener', tags: { owner: 'debug_bus.live' } }]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.listDeliveryMetrics()).toEqual([{ outcome: 'error', reason: 'TypeError', owner: 'debug_bus.live' }]);
  });
});

describe('debug bus delivery', () => {
  it('As a dotli developer, I watch the bus from the host and see boot events live while the panel still gets their replay', () => {
    // Given the host's main-thread monitor watching the buffering bus before the panel loads
    const bus = createEnabledBus();
    const watched: DebugBusEvent[] = [];
    bus.watch(event => watched.push(event));

    // When boot events fire and the panel subscribes afterwards
    bus.emit(createBootEvent('flow-1'));
    bus.emit(createBootEvent('flow-2'));
    const shown: DebugBusEvent[] = [];
    bus.subscribe(event => shown.push(event));

    // Then the watcher saw both as they happened and the panel got both replayed
    expect(watched).toEqual([createBootEvent('flow-1'), createBootEvent('flow-2')]);
    expect(shown).toEqual([createBootEvent('flow-1'), createBootEvent('flow-2')]);
  });

  it('As a dotli developer, I open a panel before any boot event and a panel opened after it left gets no replay of what was emitted meanwhile', () => {
    // Given a panel that subscribed before any event and then left
    const bus = createEnabledBus();
    const leave = bus.subscribe(() => undefined);
    leave();
    const listeningAfterLeave = bus.hasListeners();
    bus.emit(createBootEvent('flow-1'));
    bus.emit(createBootEvent('flow-2'));

    // When another panel subscribes
    const shown: DebugBusEvent[] = [];
    bus.subscribe(event => shown.push(event));

    // Then it got nothing replayed, no panel listened while none was open, and the new one listens
    expect(shown).toEqual([]);
    expect(listeningAfterLeave).toBe(false);
    expect(bus.hasListeners()).toBe(true);
  });

  it('As a dotli developer, I enable buffering again after the panel opened and a panel opened later gets no replay', () => {
    // Given a panel that got the boot replay and left, and buffering enabled again
    const bus = createEnabledBus();
    bus.emit(createBootEvent('flow-1'));
    const leave = bus.subscribe(() => undefined);
    leave();
    bus.enableBuffering();
    bus.emit(createBootEvent('flow-2'));

    // When another panel subscribes
    const shown: DebugBusEvent[] = [];
    bus.subscribe(event => shown.push(event));

    // Then it got nothing replayed
    expect(shown).toEqual([]);
  });

  it('As a dotli developer, I watch a buffering bus from the host and emit sites see no panel listening', () => {
    // Given a buffering bus with a host watcher and no panel
    const bus = createEnabledBus();
    bus.watch(() => undefined);

    // When an emit site asks whether a panel listens
    const listening = bus.hasListeners();

    // Then none does
    expect(listening).toBe(false);
  });

  it('As a dotli developer, I subscribe the panel from a host watcher during an emit and the panel gets the held events and then that event', () => {
    // Given one buffered event and a watcher that subscribes the panel on its first call
    const bus = createEnabledBus();
    const shown: DebugBusEvent[] = [];
    let subscribed = false;
    bus.emit(createBootEvent('flow-1'));
    bus.watch(() => {
      if (!subscribed) {
        subscribed = true;
        bus.subscribe(event => shown.push(event));
      }
    });

    // When another event is emitted
    bus.emit(createBootEvent('flow-2'));

    // Then the panel shows both events, in order
    expect(shown).toEqual([createBootEvent('flow-1'), createBootEvent('flow-2')]);
  });

  it('As a dotli developer, I open a second panel from inside the first panel replay and it gets no replay', () => {
    // Given two buffered events
    const bus = createEnabledBus();
    bus.emit(createBootEvent('flow-1'));
    bus.emit(createBootEvent('flow-2'));
    const first: DebugBusEvent[] = [];
    const second: DebugBusEvent[] = [];
    let opened = false;

    // When a panel subscribes and opens a second panel on its first replayed event
    bus.subscribe(event => {
      first.push(event);
      if (!opened) {
        opened = true;
        bus.subscribe(next => second.push(next));
      }
    });

    // Then the first panel shows both events and the second shows none
    expect(first).toEqual([createBootEvent('flow-1'), createBootEvent('flow-2')]);
    expect(second).toEqual([]);
  });
});
