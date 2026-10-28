// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { productState } from '../runtime/state/productState.js';
import { NetworkItem } from '../components/chains/NetworkItem.js';
import { networkStore } from '../state/network.js';
import { networkHealthStore } from '../state/networkHealth.js';
import { settingsStore } from '../state/settings.js';
import { useNetworkPanel } from './network.js';

/** The network button and its panel, bound to the page's network and its health. */
export function NetworkButton(): JSX.Element {
  const panel = useNetworkPanel({
    health: networkHealthStore,
    network: networkStore,
    product: productState.store,
    settings: settingsStore,
  });
  return <NetworkItem {...panel} />;
}
