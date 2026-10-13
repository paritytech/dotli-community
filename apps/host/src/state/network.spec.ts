// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { ChainStatus, TransferState } from './network-monitor.js';
import { createNetworkStore, networkStore, startNetworkStore, type NetworkFeed } from './network.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

/** What the monitor holds, which a test changes before it notifies. */
const monitor = {
  listeners: new Set<() => void>(),
  status: [] as unknown[],
  transfer: { bytesPerSecond: null, fetched: null, total: null } as TransferState,
};

const feed: NetworkFeed = {
  subscribe: listener => {
    monitor.listeners.add(listener);
    return () => monitor.listeners.delete(listener);
  },
  getNetworkStatus: () => monitor.status as ChainStatus[],
  getTransfer: () => monitor.transfer,
};

describe('network store', () => {
  afterEach(() => {
    resetStores();
    monitor.listeners.clear();
    Object.defineProperty(monitor, 'status', {
      configurable: true,
      writable: true,
      value: [],
    });
  });

  it('As the chains popover, the store mirrors the monitor on every change after start', () => {
    // Given
    const { store, start } = createNetworkStore();
    const stop = start(feed);
    monitor.status = [{ role: 'relay', label: 'Relay' }];

    // When
    for (const l of monitor.listeners) {
      l();
    }

    // Then
    expect(store.get().chains).toEqual([{ role: 'relay', label: 'Relay' }]);
    stop();
    expect(monitor.listeners.size).toBe(0);
  });

  it('As the host with no reader subscribed, monitor changes build no snapshot until one is read', () => {
    // Given
    let reads = 0;
    const { store, start } = createNetworkStore();
    const stop = start(feed);
    const status = [{ role: 'relay', label: 'Relay' }];
    Object.defineProperty(monitor, 'status', {
      configurable: true,
      get: () => {
        reads += 1;
        return status;
      },
    });

    // When: five notifications with nobody subscribed.
    for (let i = 0; i < 5; i += 1) {
      for (const l of monitor.listeners) {
        l();
      }
    }

    // Then
    expect(reads).toBe(0);
    expect(store.get().chains).toEqual(status);
    expect(store.get().chains).toEqual(status);
    expect(reads).toBe(1);

    // When: a reader subscribes, each notification builds one snapshot.
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe(() => {
      seen.push(store.get().chains);
    });
    for (let i = 0; i < 2; i += 1) {
      for (const l of monitor.listeners) {
        l();
      }
    }

    // Then
    expect(reads).toBe(3);
    expect(seen).toHaveLength(2);
    unsubscribe();
    stop();
  });

  it('As the chains popover, the verdict is worked out once per network update', () => {
    // Given a reader, and a live chain whose alarm only the verdict reads
    let verdicts = 0;
    const { store, start } = createNetworkStore();
    const stop = start(feed);
    const unsubscribe = store.subscribe(() => undefined);
    monitor.status = [
      Object.defineProperty({ label: 'Relay', state: 'live', sinceLast: 0, blockTimeMs: 6000 }, 'alarm', {
        get: () => {
          verdicts += 1;
          return false;
        },
      }),
    ];

    // When a block lands
    for (const l of monitor.listeners) {
      l();
    }

    // Then
    expect(store.get().verdict).toEqual({ text: 'Your connection is good', tone: 'ok' });
    expect(store.get().verdict).toEqual({ text: 'Your connection is good', tone: 'ok' });
    expect(verdicts).toBe(1);
    unsubscribe();
    stop();
  });

  it('As the host, the store does nothing until started', () => {
    // Given a monitor with a chain, the store never started
    const { store } = createNetworkStore();
    monitor.status = [{ role: 'relay', label: 'Relay' }];

    // Then
    expect(store.get().chains).toEqual([]);
    expect(monitor.listeners.size).toBe(0);
  });

  it('As a test, resetting the stores forgets a reader left subscribed, so changes build no snapshot again', () => {
    // Given: a reader that is never unsubscribed.
    networkStore.subscribe(() => undefined);
    let reads = 0;
    Object.defineProperty(monitor, 'status', {
      configurable: true,
      get: () => {
        reads += 1;
        return [];
      },
    });

    // When
    resetStores();
    const stop = startNetworkStore(feed);
    reads = 0;
    for (const l of monitor.listeners) {
      l();
    }

    // Then
    expect(reads).toBe(0);
    stop();
  });

  it('As a test, resetting the stores drops a stale mark, so the next read gets the reset value', () => {
    // Given: a change with nobody subscribed marks the store stale.
    const stop = startNetworkStore(feed);
    monitor.status = [{ role: 'relay', label: 'Relay' }];
    for (const l of monitor.listeners) {
      l();
    }
    stop();

    // When
    resetStores();

    // Then
    expect(networkStore.get().chains).toEqual([]);
    expect(networkStore.get().readAt).toBe(0);
  });
});
