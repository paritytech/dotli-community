// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveChainRoles } from '@dotli/config';
import { resetNetworkMonitor, setBlockSource, type BlockSource } from '../../src/network-monitor.js';
import { initNetworkHealth, networkHealthStore, setNetworkHealthWatched } from '../../src/state/network-health.js';
import { resetStores } from '../helpers/solid.js';

function fakeSource(): { source: BlockSource; emitAll: (n: number) => void; live: () => number } {
  const emitters = new Map<string, (n: number) => void>();
  return {
    source: {
      isReachable: () => true,
      subscribe: (genesis, onBlock) => {
        emitters.set(genesis, onBlock);
        return () => {
          emitters.delete(genesis);
        };
      },
    },
    emitAll: n => {
      for (const emit of emitters.values()) {
        emit(n);
      }
    },
    live: () => emitters.size,
  };
}

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetNetworkMonitor();
});

afterEach(() => {
  stop?.();
  stop = null;
  resetStores();
  resetNetworkMonitor();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('The network health store', () => {
  it('As a user, I see syncing until every chain delivers a block, then ok', () => {
    // Given
    const fake = fakeSource();
    setBlockSource(fake.source);
    stop = initNetworkHealth();

    // When
    setNetworkHealthWatched(true);

    // Then
    expect(networkHealthStore.get()).toBe('syncing');

    // When
    fake.emitAll(100);

    // Then
    expect(networkHealthStore.get()).toBe('ok');
  });

  it('As a user whose chains stop producing blocks, I see degraded without any new event', () => {
    // Given
    const fake = fakeSource();
    setBlockSource(fake.source);
    stop = initNetworkHealth();
    setNetworkHealthWatched(true);
    fake.emitAll(100);
    const slowest = Math.max(...getActiveChainRoles().map(role => role.blockTimeMs));

    // When
    vi.advanceTimersByTime(slowest * 3 + 2000);

    // Then
    expect(networkHealthStore.get()).toBe('degraded');
  });

  it('As a user going offline and back, I see it at once, even before any chain exists', () => {
    // Given
    stop = initNetworkHealth();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    // When
    window.dispatchEvent(new Event('offline'));

    // Then
    expect(networkHealthStore.get()).toBe('offline');

    // When
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));

    // Then
    expect(networkHealthStore.get()).toBe('syncing');
  });

  it('As a user leaving the product, the health watch stops holding the chains', () => {
    // Given
    const fake = fakeSource();
    setBlockSource(fake.source);
    stop = initNetworkHealth();
    setNetworkHealthWatched(true);
    expect(fake.live()).toBeGreaterThan(0);

    // When
    setNetworkHealthWatched(false);
    vi.advanceTimersByTime(61_000);

    // Then
    expect(fake.live()).toBe(0);
  });
});
