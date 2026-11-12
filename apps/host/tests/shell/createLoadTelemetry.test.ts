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
