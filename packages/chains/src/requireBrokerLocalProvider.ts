// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainPool } from './createChainPool.js';

type Params = {
  /** Owns the brokered connections the provider leases. */
  manager: Pick<ChainPool, 'getLocalProvider'>;
  /** The chain to reach. */
  genesisHash: string;
  /** Names the chain in the error thrown when it cannot be reached. */
  label: string;
};

/**
 * A local provider on `genesisHash` leased from `manager`, on the object wire. Throws, naming `label`, when the
 * manager cannot reach the chain.
 */
export function requireBrokerLocalProvider({ manager, genesisHash, label }: Params): JsonRpcProvider {
  const provider = manager.getLocalProvider(genesisHash, { holder: 'resolver' });
  if (provider === null) {
    throw new Error(`No broker provider available for ${label}`);
  }
  return provider;
}
