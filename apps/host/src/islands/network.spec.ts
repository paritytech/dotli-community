// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRoot, flush } from 'solid-js';
import type { Backend } from '@dotli/config';
import { createSyncStore, type ReadableStore } from '@dotli/shared';
import type { NetworkHealth } from '@dotli/ui-entities';
import type { NetworkView } from '../components/chains/chains.js';
import { useNetworkPanel } from './network.js';

const NOTHING: NetworkView = {
  chains: [],
  transfer: { bytesPerSecond: null, fetched: null, total: null },
  readAt: 0,
  verdict: { text: 'Not in use', tone: 'quiet' },
};

/** `store`, counting the readers subscribed to it. */
function countingStore<T>(store: ReadableStore<T>): { store: ReadableStore<T>; readers: { count: number } } {
  const readers = { count: 0 };
  return {
    readers,
    store: {
      ...store,
      subscribe: listener => {
        readers.count += 1;
        const unsubscribe = store.subscribe(listener);
        return () => {
          readers.count -= 1;
          unsubscribe();
        };
      },
    },
  };
}

/** The page's stores, as boot left them, and the panel's props read from them under a fresh owner. */
function mount() {
  const stores = {
    health: createSyncStore<NetworkHealth>('network-test-health', 'quiet'),
    network: createSyncStore<NetworkView>('network-test-network', NOTHING),
    product: createSyncStore<{ status: string }>('network-test-product', { status: 'idle' }),
    settings: createSyncStore<{ backend: Backend } | null>('network-test-settings', null),
  };
  const { store: network, readers } = countingStore(stores.network);
  const { panel, dispose } = createRoot(d => ({ panel: useNetworkPanel({ ...stores, network }), dispose: d }));
  flush();
  return { stores, panel, dispose, readers };
}

describe('useNetworkPanel', () => {
  it('As the network button, I follow the health the page judges', () => {
    // Given
    const { stores, panel, dispose } = mount();
    expect(panel.health()).toBe('quiet');

    // When
    stores.health.set('warn');
    flush();

    // Then
    expect(panel.health()).toBe('warn');
    dispose();
  });

  it('As the network panel, I read the product as loading until it has loaded', () => {
    // Given
    const { stores, panel, dispose } = mount();
    expect(panel.productLoaded()).toBe(false);

    // When
    stores.product.set({ status: 'loaded' });
    flush();

    // Then
    expect(panel.productLoaded()).toBe(true);
    dispose();
  });

  it('As the network panel, I read the backend once boot has read the settings', () => {
    // Given
    const { stores, panel, dispose } = mount();
    expect(panel.backend()).toBeUndefined();

    // When
    stores.settings.set({ backend: 'rpc-gateway' });
    flush();

    // Then
    expect(panel.backend()).toBe('rpc-gateway');
    dispose();
  });

  it('As the closed network button, nothing follows the network, and an open panel follows it until it closes', () => {
    // Given
    const { stores, panel, dispose, readers } = mount();
    expect(readers.count).toBe(0);

    // When the panel opens under its own owner
    const opened = createRoot(close => ({ network: panel.followNetwork(), close }));
    stores.network.set({ ...NOTHING, readAt: 1 });
    flush();

    // Then it reads the network as it changes
    expect(readers.count).toBe(1);
    expect(opened.network().readAt).toBe(1);

    // When it closes
    opened.close();

    // Then
    expect(readers.count).toBe(0);
    dispose();
  });
});
