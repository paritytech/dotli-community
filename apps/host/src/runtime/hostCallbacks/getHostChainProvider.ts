// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { isRemoteChainConnectable, type RemoteChainProvider } from '@dotli/protocol';
import { getHaltReason, requireBrokerLocalProvider, type ChainPool } from '@dotli/chains';
import { hostChainPool } from './createHostChainPool.js';

type Params = {
  /** The pool leased. The page's host chain pool by default. */
  pool?: ChainPool;
};

/**
 * Leases the chain from the pool, on the connection the products share. A halt is told as `'frame'` for a dead protocol
 * frame, `'chain'` otherwise. Returns null for a chain the protocol frame does not serve or the pool has no transport
 * for.
 */
export function getHostChainProvider(
  genesisHash: string,
  { pool = hostChainPool }: Params = {},
): RemoteChainProvider | null {
  if (!isRemoteChainConnectable(genesisHash)) {
    return null;
  }
  const lease = pool.getLocalProvider(genesisHash, { holder: 'host' });
  if (lease === null) {
    return null;
  }
  return (onMessage, onHalt) =>
    lease(onMessage, error => {
      onHalt?.(getHaltReason(error));
    });
}

/** Leases Asset Hub from the pool. Throws when the pool has no transport for it. */
export function getHostAssetHubProvider({ pool = hostChainPool }: Params = {}): JsonRpcProvider {
  return requireBrokerLocalProvider({
    manager: pool,
    genesisHash: getActiveServicesConfig().assethub.genesis,
    label: 'Asset Hub',
  });
}
