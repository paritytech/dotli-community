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
    const { store } = createNetworkState({ timers, monitor });

    // When
    monitor.recordChainPhase('relay', 'syncing');
    const syncing = store.get();
    monitor.recordChainPhase('relay', 'ready');
    const ready = getRelayPhase(store.get());

    // Then
    expect({ syncing: getRelayPhase(syncing), syncingVerdict: syncing.verdict, ready }).toEqual({
      syncing: 'syncing',
      syncingVerdict: { text: 'Connecting', tone: 'idle' },
      ready: 'ready',
    });
  });

  it('As a user opening the chains popover after a change nobody watched, I read the chains as of my opening and then hear each change', async () => {
    // Given a change while nobody is subscribed, and the popover opening five seconds later
    const { store } = createNetworkState({ timers, monitor });
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

  it('As the network panel, I read a fresh snapshot after each monitor change, and none is built while nobody reads', async () => {
    // Given a monitor that counts the snapshots built from it
    const { monitor: counting, builds } = countBuilds(monitor);
    const { store } = createNetworkState({ timers, monitor: counting });

    // When the monitor changes with nobody reading, then the panel reads after each change
    monitor.recordChainPhase('relay', 'syncing');
    const unread = builds.count;
    await timers.advance(1_000);
    const syncing = store.get();
    monitor.recordChainPhase('relay', 'ready');
    const ready = store.get();

    // Then
    expect({
      unread,
      syncing: { phase: getRelayPhase(syncing), readAt: syncing.readAt },
      ready: getRelayPhase(ready),
      builds: builds.count,
    }).toEqual({
      unread: 0,
      syncing: { phase: 'syncing', readAt: 1_000 },
      ready: 'ready',
      builds: 2,
    });
  });

  it('As a follower, I listen to the network store and hear each monitor change', () => {
    // Given
    const { store } = createNetworkState({ timers, monitor });
    const heard: string[] = [];
    store.listen(value => {
      heard.push(getRelayPhase(value) ?? 'none');
    });

    // When
    monitor.recordChainPhase('relay', 'syncing');
    monitor.recordChainPhase('relay', 'ready');

    // Then
    expect(heard).toEqual(['syncing', 'ready']);
  });

  it('As a test, I reset the stores while the network snapshot is read, and it rebuilds from the cleared monitor', () => {
    // Given a mounted snapshot that has seen a phase
    const { store } = createNetworkState({ timers, monitor });
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

/** `from`, counting each snapshot read of its chains. */
function countBuilds(from: NetworkMonitor): { monitor: NetworkMonitor; builds: { count: number } } {
  const builds = { count: 0 };
  return {
    builds,
    monitor: {
      ...from,
      getNetworkStatus() {
        builds.count += 1;
        return from.getNetworkStatus();
      },
    },
  };
}

function getRelayPhase(state: NetworkState): ChainPhase | null | undefined {
  return state.chains.find(chain => chain.role === 'relay')?.phase;
}
