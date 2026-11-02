// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Gateway mode's chains: the core set over trusted RPC nodes, behind the one pool every engine scope shares.

import { createChainPool, createCoreRpcChainProvider, isCoreRpcChainSupported } from '@dotli/chains';
import type { EngineParams } from './createEngine.js';

/** The core set, Bulletin included. An unused chain's socket closes a minute after its last connection. */
export function openGatewayChains(): Pick<EngineParams, 'pool' | 'isChainSupported'> {
  return {
    pool: createChainPool({
      createTransport: (genesisHash, hooks) => createCoreRpcChainProvider(genesisHash, { hooks }),
      destroyDelay: 60_000,
    }),
    isChainSupported: isCoreRpcChainSupported,
  };
}
