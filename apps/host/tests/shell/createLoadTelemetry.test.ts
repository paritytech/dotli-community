// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A load's reports on a page. The light client's telemetry, the block relay and the debug bus are fakes. The trace
// reads the page's window and the progress drives the page's loading screen.

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { noop } from '@dotli/shared';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { createDebugBus } from '@dotli/truapi-debug/testing';
import { pageLoading } from '../../src/createLoadingController.js';
import { createLoadTelemetry } from '../../src/createLoadTelemetry.js';
import { describeError } from '../../src/describeError.js';
import { beginAttempt } from '../../src/journey.js';
import { bindReports } from '../../src/testing/bindReports.js';

describe('createLoadTelemetry', () => {
  it('As an operator, I see an effect that comes out of order, such as a render before the start, ignored with nothing reported', () => {
    // Given
    const { telemetry, debug, captures, counted } = setupTelemetry();

    // When
    telemetry.report({ kind: 'rendering' });

    // Then
    expect(debug).toEqual([]);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(counted('load_telemetry.transition')).toEqual([]);
  });

  it('As an operator, I see a debug bus that throws as a load reports reported as a defect of the telemetry', () => {
    // Given
    const { telemetry, bus, captures, counted } = setupTelemetry();
    telemetry.report({ kind: 'started', label: 'doom' });
    telemetry.report({ kind: 'setUp' });
    const error = new Error('the debug bus threw');
    vi.spyOn(bus, 'emit').mockImplementation(() => {
      throw error;
    });

    // When
    telemetry.report({ kind: 'cacheChecked', cid: 'bafy-cached' });

    // Then
    expect(captures.exception).toHaveBeenCalledWith(error, expect.objectContaining({ step: 'transition' }));
    expect(counted('load_telemetry.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });

  it('As a dotli developer, I see a name resolve that fails end its flow in the debug panel', () => {
    // Given a load that missed the CID cache and is resolving its name
    const { telemetry, debug } = setupTelemetry();
    telemetry.report({ kind: 'started', label: 'doom' });
    telemetry.report({ kind: 'setUp' });
    telemetry.report({ kind: 'cacheChecked', cid: null });
    const error = new Error('the name did not resolve');

    // When
    telemetry.report({ kind: 'failed', error, description: describeError(error) });

    // Then
    const resolveFlowId = debug.find(event => event.layer === 'resolve' && event.event === 'started')?.flowId;
    expect(debug).toContainEqual(expect.objectContaining({ layer: 'resolve', event: 'failed', flowId: resolveFlowId }));
  });

  it('As a dotli developer, I see a name with no content end its resolve flow in the debug panel and end its journey', () => {
    // Given a load that missed the CID cache and is resolving its name
    const { telemetry, debug } = setupTelemetry();
    telemetry.report({ kind: 'started', label: 'doom' });
    telemetry.report({ kind: 'setUp' });
    telemetry.report({ kind: 'cacheChecked', cid: null });

    // When the name resolves to no content, and the name is opened again
    telemetry.report({ kind: 'nameResolved', cid: null });
    telemetry.report({ kind: 'noContent' });
    const nextAttempt = beginAttempt('doom');

    // Then
    expect(debug.filter(event => event.layer === 'resolve').map(event => event.event)).toEqual([
      'started',
      'completed',
    ]);
    expect(nextAttempt.attemptNumber).toBe(1);
  });
});

/** Builds a load's telemetry on a fresh page, with its reports and its debug events recorded. */
function setupTelemetry() {
  resetAllStoresForTests();
  const { captures, counted } = bindReports();
  const debug: DotliDebugEvent[] = [];
  const bus = createDebugBus();
  bus.enableBuffering();
  const unwatch = bus.watch(event => {
    if ('layer' in event) {
      debug.push(event);
    }
  });
  onTestFinished(() => {
    // The progress starts the page's loading screen.
    pageLoading.stopStatusTick();
    unwatch();
  });
  const telemetry = createLoadTelemetry({
    backend: 'smoldot-direct',
    skipCidCache: false,
    flowId: 'boot-1',
    startedAt: 0,
    blockRelay: { onProgress: () => noop },
    telemetry: {
      subscribeChainSync: () => noop,
      subscribeChainDetail: () => noop,
      subscribeNetBytes: () => noop,
      getSmoldotDbOutcome: () => 'unknown',
    },
    debugBus: bus,
  });
  return {
    telemetry,
    /** The debug bus the load's events go to. */
    bus,
    /** Each debug panel event the load sent, in order. */
    debug,
    /** The capture sink's exception and expected-failure spies. */
    captures,
    /** The attributes of each count named `dotli.<name>`, in order. */
    counted,
  };
}
