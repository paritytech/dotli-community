// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
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

  it('As a user with the chains popover open, I watch a chain come up and see each phase and the verdict until the network state stops', () => {
    // Given
    const { store, start } = createNetworkState({ timers });
    const stop = start({ monitor });

    // When
    monitor.recordChainPhase('relay', 'syncing');
    const syncing = store.get();
    monitor.recordChainPhase('relay', 'ready');
    const ready = getRelayPhase(store.get());
    stop();
    monitor.recordChainPhase('relay', 'stalled');

    // Then
    expect({
      syncing: getRelayPhase(syncing),
      syncingVerdict: syncing.verdict,
      ready,
      afterStop: getRelayPhase(store.get()),
    }).toEqual({
      syncing: 'syncing',
      syncingVerdict: { text: 'Connecting', tone: 'idle' },
      ready: 'ready',
      afterStop: 'ready',
    });
  });

  it('As a user opening the chains popover after a change nobody watched, I read the chains as of my opening and then hear each change', async () => {
    // Given a change while nobody is subscribed, and the popover opening five seconds later
    const { store, start } = createNetworkState({ timers });
    onTestFinished(start({ monitor }));
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

  it('As a follower, I listen to the network store and hear each monitor change after start', () => {
    // Given
    const { store, start } = createNetworkState({ timers });
    start({ monitor });
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

  it('As a user before the network state starts, I watch a chain come up and see no chain listed', () => {
    // Given a monitor that heard a chain, the store never started
    const { store } = createNetworkState({ timers });

    // When
    monitor.recordChainPhase('relay', 'syncing');

    // Then
    expect(store.get().chains).toEqual([]);
  });

  it('As a user whose page started the network state twice, I see one caller stop and still hear each chain change once', () => {
    // Given
    const { store, start } = createNetworkState({ timers });
    const notified = recordNotified(store);
    onTestFinished(start({ monitor }));
    const stopSecond = start({ monitor });

    // When
    stopSecond();
    monitor.recordChainPhase('relay', 'syncing');

    // Then
    expect(notified.map(getRelayPhase)).toEqual([null, 'syncing']);
  });

  it('As a user with the chains popover open on a page that restarted the network state, I call a stop from before the restart and still see the chains popover follow each change', () => {
    // Given a reader, so the store shows what the follow last heard
    const { store, start } = createNetworkState({ timers });
    recordNotified(store);
    const stopFirst = start({ monitor });
    stopFirst();
    onTestFinished(start({ monitor }));

    // When
    stopFirst();
    monitor.recordChainPhase('relay', 'syncing');

    // Then
    expect(getRelayPhase(store.get())).toBe('syncing');
  });

  it('As a store reset during a follow, I end it once and a stop left from it does nothing', () => {
    // Given a follow on a monitor whose subscription counts its unsubscribes
    const { start } = createNetworkState({ timers });
    let unsubscribes = 0;
    const counting: NetworkMonitor = {
      ...monitor,
      subscribe(listener) {
        const unsubscribe = monitor.subscribe(listener);
        return () => {
          unsubscribes += 1;
          unsubscribe();
        };
      },
    };
    const stop = start({ monitor: counting });

    // When the stores reset, then the stop left from the ended follow runs
    resetStores();
    const afterReset = unsubscribes;
    stop();

    // Then the reset ended the follow once and the stop added nothing
    expect({ afterReset, total: unsubscribes }).toEqual({ afterReset: 1, total: 1 });
  });
});

function getRelayPhase(state: NetworkState): ChainPhase | null | undefined {
  return state.chains.find(chain => chain.role === 'relay')?.phase;
}
