// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveChainRoles } from '@dotli/config';
import { createNetworkMonitor, type NetworkMonitor } from './network-monitor.js';
import { initNetworkHealth as initPageNetworkHealth, networkHealthStore } from './network-health.js';
import { FakePage, resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

/** Every chain is connectable, so only what the monitor hears decides the health. */
let monitor: NetworkMonitor;

const relay = (): string => getActiveChainRoles()[0]?.genesis ?? '';

function useAll(): void {
  for (const role of getActiveChainRoles()) {
    monitor.recordChainActivity({ genesisHash: role.genesis, consumers: 1, status: 'connected', following: true });
  }
}

function blockAll(blockNumber: number): void {
  for (const role of getActiveChainRoles()) {
    monitor.recordBestBlock(role.genesis, blockNumber);
  }
}

let stop: (() => void) | null = null;
let page: FakePage;

/** The health over a page whose visibility and connectivity the test sets. */
function initNetworkHealth(on: Parameters<typeof initPageNetworkHealth>[0]): () => void {
  return initPageNetworkHealth(on, {
    isHidden: () => page.hidden,
    isOnline: () => page.onLine,
    visibility: page,
    connectivity: page,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  page = new FakePage();
  monitor = createNetworkMonitor({ isConnectable: () => true });
});

afterEach(() => {
  stop?.();
  stop = null;
  resetStores();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('The network health store', () => {
  it('As a user, I see syncing until every chain in use delivers a block, then ok', () => {
    // Given
    stop = initNetworkHealth(monitor);

    // When
    useAll();

    // Then
    expect(networkHealthStore.get()).toBe('idle');

    // When
    blockAll(100);

    // Then
    expect(networkHealthStore.get()).toBe('ok');
  });

  it('As a user whose chains stop producing blocks, I see degraded without any new event', () => {
    // Given
    stop = initNetworkHealth(monitor);
    useAll();
    blockAll(100);
    const slowest = Math.max(...getActiveChainRoles().map(role => role.blockTimeMs));

    // When
    vi.advanceTimersByTime(slowest * 3 + 2000);

    // Then
    expect(networkHealthStore.get()).toBe('warn');
  });

  it('As a user, the health rechecks once, when the first chain would be overdue, and a block moves that one recheck', () => {
    // Given
    stop = initNetworkHealth(monitor);
    useAll();

    // Then: before any block nothing can fall overdue
    expect(vi.getTimerCount()).toBe(0);

    // When
    blockAll(100);

    // Then
    expect(vi.getTimerCount()).toBe(1);

    // When
    vi.advanceTimersByTime(1000);
    blockAll(101);

    // Then
    expect(vi.getTimerCount()).toBe(1);
    expect(networkHealthStore.get()).toBe('ok');
  });

  it('As a user in another tab, the health is not rechecked until the tab shows again', () => {
    // Given
    stop = initNetworkHealth(monitor);
    useAll();
    blockAll(100);
    const slowest = Math.max(...getActiveChainRoles().map(role => role.blockTimeMs));

    // When
    page.setVisibility('hidden');
    vi.advanceTimersByTime(slowest * 3 + 2000);

    // Then
    expect(vi.getTimerCount()).toBe(0);
    expect(networkHealthStore.get()).toBe('ok');

    // When
    page.setVisibility('visible');

    // Then
    expect(networkHealthStore.get()).toBe('warn');
  });

  it('As a user going offline and back, I see it at once, even before any chain exists', () => {
    // Given
    stop = initNetworkHealth(monitor);

    // When
    page.setOnline(false);

    // Then
    expect(networkHealthStore.get()).toBe('err');

    // When
    page.setOnline(true);

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
  });

  it('As a user who went offline while the page booted, the capsule turns red once the network health starts', () => {
    // Given a page that went offline before the health started
    page.setOnline(false);

    // When
    stop = initNetworkHealth(monitor);

    // Then: the capsule takes the health's tone
    expect(networkHealthStore.get()).toBe('err');
  });

  it('As a user before any app holds a chain, I see quiet', () => {
    // When
    stop = initNetworkHealth(monitor);

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
  });

  it('As a user loading a product, the frame syncing a chain shows syncing, and ready with nothing in use shows quiet', () => {
    // Given
    stop = initNetworkHealth(monitor);

    // When
    monitor.recordChainPhase('relay', 'syncing');

    // Then
    expect(networkHealthStore.get()).toBe('idle');

    // When
    monitor.recordChainPhase('relay', 'ready');

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
  });

  it('As a user, a frame chain that was ready and drops back to connecting shows unstable', () => {
    // Given
    stop = initNetworkHealth(monitor);
    monitor.recordChainPhase('relay', 'ready');

    // When
    monitor.recordChainPhase('relay', 'connecting');

    // Then
    expect(networkHealthStore.get()).toBe('warn');
  });

  it('As a user leaving the page, I stop the health store and it leaves its monitor with no listener', () => {
    // Given: a monitor that counts who listens to it
    const listening = new Set<() => void>();
    const counted: NetworkMonitor = {
      ...monitor,
      subscribe: listener => {
        listening.add(listener);
        const unsubscribe = monitor.subscribe(listener);
        return () => {
          listening.delete(listener);
          unsubscribe();
        };
      },
    };
    stop = initNetworkHealth(counted);
    expect(listening.size).toBe(1);

    // When
    stop();
    stop = null;

    // Then: no listener is left, and later blocks change nothing
    expect(listening.size).toBe(0);
    useAll();
    blockAll(100);
    expect(networkHealthStore.get()).toBe('quiet');
  });

  it('As a user whose only live chain is released, an armed recheck never turns the indicator unstable', () => {
    // Given
    stop = initNetworkHealth(monitor);
    monitor.recordChainActivity({ genesisHash: relay(), consumers: 1, status: 'connected', following: true });
    monitor.recordBestBlock(relay(), 100);
    expect(networkHealthStore.get()).toBe('ok');

    // When
    monitor.recordChainActivity({ genesisHash: relay(), consumers: 0, status: 'connected', following: false });
    vi.advanceTimersByTime(60_000);

    // Then
    expect(networkHealthStore.get()).toBe('quiet');
    expect(vi.getTimerCount()).toBe(0);
  });
});
