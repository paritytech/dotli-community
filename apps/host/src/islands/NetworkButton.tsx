// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { productStore } from '../runtime/state/product.js';
import { NetworkItem } from '../components/topbar/items.js';
import { networkStore } from '../state/network.js';
import { networkHealthStore } from '../state/network-health.js';
import { settingsStore } from '../state/settings.js';
import { useNetworkPanel } from './network.js';

/** The network button and its panel, bound to the page's network and its health. */
export function NetworkButton(): JSX.Element {
  const panel = useNetworkPanel({
    health: networkHealthStore,
    network: networkStore,
    product: productStore,
    settings: settingsStore,
  });
  return <NetworkItem {...panel} />;
}
