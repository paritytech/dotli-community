// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Backend } from '@dotli/config';
import { useStore, type StoreSource } from '@dotli/stores-solid';
import type { NetworkHealth } from '../components/chains/networkHealth.js';
import type { NetworkView } from '../components/chains/chains.js';
import type { NetworkItemProps } from '../components/chains/NetworkItem.js';
import { INITIAL_NETWORK } from '../state/networkState.js';

export type NetworkStores = {
  health: StoreSource<NetworkHealth>;
  network: StoreSource<NetworkView>;
  product: StoreSource<{ status: string }>;
  settings: StoreSource<{ backend: Backend } | null>;
};

/** The network button's props, for an island's own lifetime. */
export function useNetworkPanel(stores: NetworkStores): NetworkItemProps {
  return {
    health: useStore(stores.health),
    // The network store rebuilds only while someone reads it, so the panel subscribes only while it is open.
    followNetwork: () => useStore(stores.network, value => value, { initial: INITIAL_NETWORK }),
    productLoaded: useStore(stores.product, product => product.status === 'loaded'),
    backend: useStore(stores.settings, settings => settings?.backend),
  };
}
