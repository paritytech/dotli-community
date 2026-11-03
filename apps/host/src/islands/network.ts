// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Backend } from '@dotli/config';
import type { ReadableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import type { NetworkHealth } from '../components/chains/networkHealth.js';
import type { NetworkView } from '../components/chains/chains.js';
import type { NetworkItemProps } from '../components/chains/NetworkItem.js';

export type NetworkStores = {
  health: ReadableAtom<NetworkHealth>;
  network: ReadableAtom<NetworkView>;
  product: ReadableAtom<{ status: string }>;
  settings: ReadableAtom<{ backend: Backend } | null>;
};

/** The network as a build-time render shows it, before any chain is in use. */
export const INITIAL_NETWORK: NetworkView = {
  chains: [],
  transfer: { bytesPerSecond: null, fetched: null, total: null },
  readAt: 0,
  verdict: { text: 'Not in use', tone: 'quiet' },
};

/** The network button's props, for an island's own lifetime. */
export function useNetworkPanel(stores: NetworkStores): NetworkItemProps {
  return {
    health: useStore(stores.health),
    // The network store rebuilds only while someone reads it, so the panel subscribes only while it is open.
    followNetwork: () => useStore(stores.network, { initial: INITIAL_NETWORK }),
    productLoaded: useStore(stores.product, product => product.status === 'loaded'),
    backend: useStore(stores.settings, settings => settings?.backend),
  };
}
