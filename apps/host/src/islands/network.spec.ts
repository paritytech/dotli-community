// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { atom, computed } from 'nanostores';
import type { Backend } from '@dotli/config';
import type { StoreSource } from '@dotli/stores-solid';
import type { NetworkHealth } from '../components/chains/networkHealth.js';
import type { NetworkView } from '../components/chains/chains.js';
import { INITIAL_NETWORK } from '../state/networkState.js';
import { useNetworkPanel } from './network.js';

/** `store`, counting the readers listening to it. */
function countingStore<T>(store: StoreSource<T>): { store: StoreSource<T>; readers: { count: number } } {
  const readers = { count: 0 };
  return {
    readers,
    store: {
      get: () => store.get(),
      init: store.init,
      listen: listener => {
        readers.count += 1;
        const unlisten = store.listen(listener);
        return () => {
          readers.count -= 1;
          unlisten();
        };
      },
    },
  };
}

/** The page's stores, as boot left them, and the panel's props read from them under a fresh owner. */
function mount() {
  const stores = {
    health: atom<NetworkHealth>('quiet'),
    network: atom<NetworkView>(INITIAL_NETWORK),
    product: atom<{ status: string }>({ status: 'idle' }),
    settings: atom<{ backend: Backend } | null>(null),
  };
  // A computed, which has no `init`
  const { store: network, readers } = countingStore(computed(stores.network, value => value));
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
    stores.network.set({ ...INITIAL_NETWORK, readAt: 1 });
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
