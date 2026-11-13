// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualTimers, resetAllStoresForTests as resetStores, type ManualTimers } from '@dotli/shared/testing';
import { createNetworkMonitorState, type ChainPhase, type NetworkMonitor } from './networkMonitorState.js';
import { createNetworkState, type NetworkState } from './networkState.js';
import { recordNotified } from '../testing/recordNotified.js';

/** Every chain is connectable, so only what the monitor hears decides what the store shows. */
let monitor: NetworkMonitor;
let timers: ManualTimers;

describe('network store', () => {
  beforeEach(() => {
    timers = createManualTimers();
    monitor = createNetworkMonitorState({ isConnectable: () => true, timers });
  });

  afterEach(() => {
    resetStores();
  });

  it('As a user with the chains popover open, I watch a chain come up and see each phase and the verdict', () => {
    // Given
    const store = createNetworkState({ timers, monitor });

    // When
    monitor.recordChainPhase('relay', 'syncing');
    const syncing = store.get();
    monitor.recordChainPhase('relay', 'ready');
    const ready = getRelayPhase(store.get());

    // Then
    expect({ syncing: getRelayPhase(syncing), syncingVerdict: syncing.verdict, ready }).toEqual({
      syncing: 'syncing',
      syncingVerdict: { tone: 'idle' },
      ready: 'ready',
    });
  });

  it('As a user opening the chains popover after a change nobody watched, I read the chains as of my opening and then hear each change', async () => {
    // Given a change while nobody is subscribed, and the popover opening five seconds later
    const store = createNetworkState({ timers, monitor });
    monitor.recordChainPhase('relay', 'syncing');
    await timers.advance(5_000);

    // When
    const opened = store.get();
    const notified = recordNotified(store);
    monitor.recordChainPhase('relay', 'ready');

    // Then
    expect({ phase: getRelayPhase(opened), readAt: opened.readAt, heard: notified.map(getRelayPhase) }).toEqual({
      phase: 'syncing',
      readAt: 5_000,
      heard: ['ready'],
    });
  });

  it('As a test, I reset the stores while the network snapshot is read, and it rebuilds from the cleared monitor', () => {
    // Given a mounted snapshot that has seen a phase
    const store = createNetworkState({ timers, monitor });
    const stop = store.listen(() => undefined);
    monitor.recordChainPhase('relay', 'syncing');

    // When
    resetStores();
    const phase = getRelayPhase(store.get());
    stop();

    // Then
    expect(phase).toBeNull();
  });
});

function getRelayPhase(state: NetworkState): ChainPhase | null | undefined {
  return state.chains.find(chain => chain.role === 'relay')?.phase;
}
