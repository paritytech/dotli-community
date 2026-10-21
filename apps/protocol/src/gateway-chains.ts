// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Gateway mode's chains: the core set over trusted RPC nodes, behind the one pool every engine scope shares.

import { createChainPool, createCoreRpcChainProvider, isCoreRpcChainSupported } from '@dotli/chains';
import type { EngineOptions } from './engine.js';

/**
 * The core set, so the network panel can watch Bulletin. Advertisement to dApps is curated in
 * `isRemoteChainSupported`. An unused chain's socket closes a minute after its last connection.
 */
export function openGatewayChains(): Pick<EngineOptions, 'pool' | 'isChainSupported'> {
  return {
    pool: createChainPool({ createTransport: createCoreRpcChainProvider, destroyDelay: 60_000 }),
    isChainSupported: isCoreRpcChainSupported,
  };
}
