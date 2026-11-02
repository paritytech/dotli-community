// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { productState } from '../runtime/state/productState.js';
import { NetworkItem } from '../components/chains/NetworkItem.js';
import { networkState } from '../state/networkState.js';
import { networkHealthState } from '../state/networkHealthState.js';
import { settingsState } from '../state/settingsState.js';
import { useNetworkPanel } from './network.js';

/** The network button and its panel, bound to the page's network and its health. */
export function NetworkButton(): JSX.Element {
  const panel = useNetworkPanel({
    health: networkHealthState.store,
    network: networkState.store,
    product: productState.store,
    settings: settingsState.store,
  });
  return <NetworkItem {...panel} />;
}
