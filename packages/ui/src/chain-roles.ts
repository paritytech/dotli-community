// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one place the resolver wire names (`ChainKey`) meet the config role names (`ChainRole`).

import type { ChainRole } from '@dotli/config';
import type { ChainKey } from '@dotli/resolver';

/** A custom relay still maps to the relay, as the loading screen treats it. */
const ROLE_BY_CHAIN_KEY: Record<ChainKey, ChainRole> = {
  relay: 'relay',
  'asset-hub': 'assethub',
  bulletin: 'bulletin',
  people: 'people',
};

export function chainRoleForKey(chain: ChainKey): ChainRole {
  return ROLE_BY_CHAIN_KEY[chain];
}
