// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { atom, computed } from 'nanostores';
import type { Backend } from '@dotli/config';
import type { NetworkHealth } from '../components/chains/networkHealth.js';
import type { NetworkView } from '../components/chains/chains.js';
import { INITIAL_NETWORK, useNetworkPanel } from './network.js';

/** The page's stores, as boot left them, and the panel's props read from them under a fresh owner. */
function mount() {
  const stores = {
    health: atom<NetworkHealth>('quiet'),
    network: atom<NetworkView>(INITIAL_NETWORK),
    product: atom<{ status: string }>({ status: 'idle' }),
    settings: atom<{ backend: Backend } | null>(null),
  };
  // A computed, which has no `init`
  const network = computed(stores.network, value => value);
  const { panel, dispose } = createRoot(d => ({ panel: useNetworkPanel({ ...stores, network }), dispose: d }));
  flush();
  return { stores, panel, dispose, network };
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
    const { stores, panel, dispose, network } = mount();
    expect(network.lc).toBe(0);

    // When the panel opens under its own owner
    const opened = createRoot(close => ({ network: panel.followNetwork(), close }));
    stores.network.set({ ...INITIAL_NETWORK, readAt: 1 });
    flush();

    // Then it reads the network as it changes
    expect(network.lc).toBe(1);
    expect(opened.network().readAt).toBe(1);

    // When it closes
    opened.close();

    // Then
    expect(network.lc).toBe(0);
    dispose();
  });
});
