// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindLogSink } from '@dotli/shared';
import { createDotliDebugBus, type DotliDebugBus, type DotliDebugBusEvent } from './dotli-debug-bus.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';

interface ListenerReports {
  captured: { step: string; tags: Record<string, string> | undefined }[];
  errors: string[];
  counted: () => (Record<string, string> | undefined)[];
}

/** Record the captures, error lines and metrics a throwing listener leaves, until the test ends. */
function recordListenerReports(): ListenerReports {
  const captured: ListenerReports['captured'] = [];
  const errors: string[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (_err, ctx) => captured.push({ step: ctx.step, tags: ctx.tags }),
      expected: () => undefined,
    }),
  );
  onTestFinished(
    bindLogSink({
      emit: (level, message) => {
        if (level === 'error') {
          errors.push(message);
        }
      },
    }),
  );
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { captured, errors, counted: () => metrics.counted('debug_bus.listener') };
}

function enabledBus(): DotliDebugBus {
  const bus = createDotliDebugBus();
  bus.enableBuffering();
  return bus;
}

function bootEvent(flowId: string): DotliDebugBusEvent {
  return { layer: 'boot', event: 'started', flowId, timestamp: 0, payload: {} } as unknown as DotliDebugBusEvent;
}

describe('dotli debug bus listener failures', () => {
  it('As a dotli developer, a host watcher that throws is reported and the next watcher and the panel still get the event', () => {
    // Given a watcher that throws on every event, a watcher after it and a mounted panel
    const reports = recordListenerReports();
    const bus = enabledBus();
    bus.watch(() => {
      throw new TypeError('watcher broke');
    });
    const watched: DotliDebugBusEvent[] = [];
    bus.watch(event => watched.push(event));
    const shown: DotliDebugBusEvent[] = [];
    bus.on(event => shown.push(event));

    // When an event is emitted
    bus.emit(bootEvent('flow-1'));

    // Then both later receivers got it, and the throw was reported once
    expect(watched).toEqual([bootEvent('flow-1')]);
    expect(shown).toEqual([bootEvent('flow-1')]);
    expect(reports.captured).toEqual([{ step: 'debug_bus_listener', tags: { delivery: 'watch' } }]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.counted()).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As a dotli developer, a panel that throws on a replayed boot event is reported and still gets the rest of the replay', () => {
    // Given two boot events buffered before the panel loads
    const reports = recordListenerReports();
    const bus = enabledBus();
    bus.emit(bootEvent('flow-1'));
    bus.emit(bootEvent('flow-2'));

    // When the panel subscribes and throws on the first replayed event
    const shown: DotliDebugBusEvent[] = [];
    bus.on(event => {
      if (shown.length === 0) {
        shown.push(event);
        throw new RangeError('panel broke');
      }
      shown.push(event);
    });

    // Then it still got the second, and the throw was reported once
    expect(shown).toEqual([bootEvent('flow-1'), bootEvent('flow-2')]);
    expect(reports.captured).toEqual([{ step: 'debug_bus_listener', tags: { delivery: 'replay' } }]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.counted()).toEqual([{ outcome: 'error', reason: 'RangeError' }]);
  });
});

describe('dotli debug bus delivery', () => {
  it('As a dotli developer, a host watcher sees boot events live and the panel still gets their replay', () => {
    // Given the host's main-thread monitor watching the buffering bus before the panel loads
    const bus = enabledBus();
    const watched: DotliDebugBusEvent[] = [];
    bus.watch(event => watched.push(event));

    // When boot events fire and the panel subscribes afterwards
    bus.emit(bootEvent('flow-1'));
    bus.emit(bootEvent('flow-2'));
    const shown: DotliDebugBusEvent[] = [];
    bus.on(event => shown.push(event));

    // Then the watcher saw both as they happened and the panel got both replayed
    expect(watched).toEqual([bootEvent('flow-1'), bootEvent('flow-2')]);
    expect(shown).toEqual([bootEvent('flow-1'), bootEvent('flow-2')]);
  });
});
