// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { productState } from '../page/index.js';
import { NetworkItem } from './NetworkItem.js';
import { networkState } from './networkState.js';
import { networkHealthState } from './networkHealthState.js';
import { settingsState } from '../settings/index.js';
import { useNetworkPanel } from './network.js';

/** The network button and its panel, bound to the page's network and its health. */
export function NetworkButtonIsland(): JSX.Element {
  const panel = useNetworkPanel({
    health: networkHealthState.store,
    network: networkState,
    product: productState.store,
    settings: settingsState.store,
  });
  return <NetworkItem {...panel} />;
}
