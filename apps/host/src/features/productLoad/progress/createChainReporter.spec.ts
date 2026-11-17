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

  it("As a developer with the debug panel, I see the load's byte totals sampled at most once a second", () => {
    // Given a reporter
    const { reporter, timers, readBytes } = setupReporter();

    // When three totals arrive, the second within a second of the first
    reporter.recordBytes(100);
    timers.freeze(500);
    reporter.recordBytes(200);
    timers.freeze(500);
    reporter.recordBytes(300);

    // Then the first and the third go out
    expect(readBytes()).toEqual([{ received: 100 }, { received: 300 }]);
  });

  it('As a developer with the debug panel, I see a load whose byte counter only reads zero hand off and hear no total', () => {
    // Given a byte counter that reports its zero baseline and nothing more
    const { reporter, timers, readBytes } = setupReporter();
    reporter.recordBytes(0);
    timers.freeze(1_000);
    reporter.recordBytes(0);

    // When the load hands off
    reporter.closeBytes();

    // Then
    expect(readBytes()).toEqual([]);
  });

  it('As a developer with the debug panel, I see the load hand off before any byte total and hear no total', () => {
    // Given a reporter that heard no total
    const { reporter, timers, readBytes } = setupReporter();

    // When the load hands off, and a total arrives later
    reporter.closeBytes();
    timers.freeze(5_000);
    reporter.recordBytes(100);

    // Then
    expect(readBytes()).toEqual([]);
  });

  it('As a developer with the debug panel, I see the load hand off and the last total heard reported', () => {
    // Given a second total within a second of the first, so it went unreported
    const { reporter, timers, readBytes } = setupReporter();
    reporter.recordBytes(100);
    timers.freeze(500);
    reporter.recordBytes(200);

    // When the load hands off
    reporter.closeBytes();

    // Then
    expect(readBytes()).toEqual([{ received: 100 }, { received: 200 }]);
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
  return { reporter, timers, readPhases, readBytes };

  function readPhases(): unknown[] {
    return events.flatMap(event => (event.layer === 'chain' && event.event === 'phase' ? [event.payload] : []));
  }

  function readBytes(): unknown[] {
    return events.flatMap(event => (event.layer === 'chain' && event.event === 'bytes' ? [event.payload] : []));
  }
}
