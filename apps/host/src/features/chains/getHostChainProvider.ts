// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { requireBrokerLocalProvider, type ChainPool } from '@dotli/chains';
import { hostChainPool } from './createHostChainPool.js';

type Params = {
  /** The pool leased. The page's host chain pool by default. */
  pool?: ChainPool;
};

/**
 * Leases the chain from the pool, on the connection the products share. Its connections heal after a halt. Returns null
 * for a chain the pool has no transport for, as for one the backend in force does not serve.
 */
export function getHostChainProvider(
  genesisHash: string,
  { pool = hostChainPool }: Params = {},
): JsonRpcProvider | null {
  return pool.getLocalProvider(genesisHash, { holder: 'host' });
}

/** Leases Asset Hub from the pool. Throws when the pool has no transport for it. */
export function getHostAssetHubProvider({ pool = hostChainPool }: Params = {}): JsonRpcProvider {
  return requireBrokerLocalProvider({
    manager: pool,
    genesisHash: getActiveServicesConfig().assethub.genesis,
    label: 'Asset Hub',
  });
}
