// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which chains the protocol frame serves. Apart from the connections, so a page that only asks does not load them.

import {
  getActiveCoreGatewaySupportedGenesisHashes,
  getActiveGatewaySupportedGenesisHashes,
  getActiveSupportedGenesisHashes,
  getBackend,
} from '@dotli/config';

/**
 * Wider than the advertised `isRemoteChainSupported`, since gateway mode keeps Bulletin connectable for bitswap's
 * content fetches through the frame.
 */
export function isRemoteChainConnectable(genesisHash: string): boolean {
  const supported =
    getBackend() === 'rpc-gateway' ? getActiveCoreGatewaySupportedGenesisHashes() : getActiveSupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}

export function isRemoteChainSupported(genesisHash: string): boolean {
  // Gateway mode bridges a curated RPC subset, while smoldot can run any configured chain.
  const supported =
    getBackend() === 'rpc-gateway' ? getActiveGatewaySupportedGenesisHashes() : getActiveSupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}
