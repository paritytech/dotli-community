// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { createDebugBus } from '@dotli/truapi-debug/testing';
import { createChainReporter } from './createChainReporter.js';

describe('createChainReporter', () => {
  it('As an operator, I see one phase event when a chain repeats the phase it is in', () => {
    // Given a reporter
    const { reporter, readPhases } = setupReporter();

    // When the relay says it is connecting twice
    reporter.record({ chain: 'relay', kind: 'connecting' });
    reporter.record({ chain: 'relay', kind: 'connecting' });

    // Then
    expect(readPhases()).toEqual([{ chain: 'relay', phase: 'connecting' }]);
  });

  it('As an operator, I see a warp sync sampled at most once a second', () => {
    // Given a reporter
    const { reporter, timers, readPhases } = setupReporter();

    // When the relay's warp moves three times, the second within a second of the first
    reporter.record({ chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 100 });
    timers.freeze(500);
    reporter.record({ chain: 'relay', kind: 'warpSyncProgress', at: 20, target: 100 });
    timers.freeze(500);
    reporter.record({ chain: 'relay', kind: 'warpSyncProgress', at: 30, target: 100 });

    // Then the first and the third go out
    expect(readPhases()).toEqual([
      { chain: 'relay', phase: 'syncing', warpAt: 10, warpTarget: 100 },
      { chain: 'relay', phase: 'syncing', warpAt: 30, warpTarget: 100 },
    ]);
  });
});

/** Builds a reporter over a fresh debug bus, a manual clock and a monitor that keeps nothing. */
function setupReporter() {
  const timers = createManualTimers({ start: 1000 });
  const debugBus = createDebugBus();
  debugBus.enableBuffering();
  const events: DotliDebugEvent[] = [];
  onTestFinished(
    debugBus.watch(event => {
      if ('layer' in event) {
        events.push(event);
      }
    }),
  );
  const reporter = createChainReporter({
    flowId: 'flow',
    timers,
    debugBus,
    monitor: { recordPeerCount: () => undefined, recordChainPhase: () => undefined },
  });
  return { reporter, timers, readPhases };

  function readPhases(): unknown[] {
    return events.flatMap(event => (event.layer === 'chain' && event.event === 'phase' ? [event.payload] : []));
  }
}
