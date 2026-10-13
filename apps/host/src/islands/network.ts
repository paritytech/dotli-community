// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Backend } from '@dotli/config';
import type { ReadableStore } from '@dotli/shared';
import { useStore } from '@dotli/ui';
import type { NetworkHealth } from '@dotli/ui-entities';
import type { NetworkView } from '../components/chains/chains.js';
import type { NetworkItemProps } from '../components/topbar/items.js';

export interface NetworkStores {
  health: ReadableStore<NetworkHealth>;
  network: ReadableStore<NetworkView>;
  product: ReadableStore<{ status: string }>;
  settings: ReadableStore<{ backend: Backend } | null>;
}

/** The network button's props, for an island's own lifetime. */
export function useNetworkPanel(stores: NetworkStores): NetworkItemProps {
  return {
    health: useStore(stores.health),
    // The network store rebuilds only while someone reads it, so the panel subscribes only while it is open.
    followNetwork: () => useStore(stores.network),
    productLoaded: useStore(stores.product, product => product.status === 'loaded'),
    backend: useStore(stores.settings, settings => settings?.backend),
  };
}
