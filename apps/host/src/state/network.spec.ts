// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadableStore } from '@dotli/shared';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';
import { createNetworkMonitor, type ChainPhase, type NetworkMonitor } from './network-monitor.js';
import { createNetworkStore, type NetworkState } from './network.js';

/** Every chain is connectable, so only what the monitor hears decides what the store shows. */
let monitor: NetworkMonitor;

function relayPhase(store: ReadableStore<NetworkState>): ChainPhase | null | undefined {
  return store.get().chains.find(chain => chain.role === 'relay')?.phase;
}

describe('network store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    monitor = createNetworkMonitor({ isConnectable: () => true });
  });

  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  it('As the chains popover, the store mirrors the monitor and its verdict on every change after start, and stops at stop', () => {
    // Given
    const { store, start } = createNetworkStore();
    const stop = start(monitor);

    // When
    monitor.recordChainPhase('relay', 'syncing');
    const syncing = relayPhase(store);
    const syncingVerdict = store.get().verdict;
    monitor.recordChainPhase('relay', 'ready');
    const ready = relayPhase(store);
    stop();
    monitor.recordChainPhase('relay', 'stalled');

    // Then
    expect(syncing).toBe('syncing');
    expect(syncingVerdict).toEqual({ text: 'Connecting', tone: 'idle' });
    expect(ready).toBe('ready');
    expect(relayPhase(store)).toBe('ready');
  });

  it('As the chains popover opening after the monitor changed unwatched, I read the chains as of my opening, then hear each change', () => {
    // Given a change while nobody is subscribed, and the popover opening five seconds later
    const { store, start } = createNetworkStore();
    const stop = start(monitor);
    monitor.recordChainPhase('relay', 'syncing');
    vi.advanceTimersByTime(5_000);
    const openedAt = Date.now();

    // When
    const opened = store.get();
    const heard: (ChainPhase | null | undefined)[] = [];
    const unsubscribe = store.subscribe(() => {
      heard.push(relayPhase(store));
    });
    monitor.recordChainPhase('relay', 'ready');
    unsubscribe();
    stop();

    // Then
    expect(opened.chains.find(chain => chain.role === 'relay')?.phase).toBe('syncing');
    expect(opened.readAt).toBe(openedAt);
    expect(heard).toEqual(['ready']);
  });

  it('As the host, the store does nothing until started', () => {
    // Given a monitor that heard a chain, the store never started
    const { store } = createNetworkStore();

    // When
    monitor.recordChainPhase('relay', 'syncing');

    // Then
    expect(store.get().chains).toEqual([]);
  });
});
