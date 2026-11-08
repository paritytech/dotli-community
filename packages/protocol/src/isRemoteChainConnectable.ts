// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getActiveCoreGatewaySupportedGenesisHashes,
  getActiveSupportedGenesisHashes,
  getBackend,
  hasLightClient,
} from '@dotli/config';

/**
 * Whether the protocol frame can connect the chain of `genesisHash`. Wider than the advertised chains, since gateway
 * mode keeps Bulletin connectable for bitswap's content fetches through the frame.
 */
export function isRemoteChainConnectable(genesisHash: string): boolean {
  const supported = hasLightClient(getBackend())
    ? getActiveSupportedGenesisHashes()
    : getActiveCoreGatewaySupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}
