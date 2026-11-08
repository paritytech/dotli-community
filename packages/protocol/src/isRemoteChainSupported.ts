// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getActiveGatewaySupportedGenesisHashes,
  getActiveSupportedGenesisHashes,
  getBackend,
  hasLightClient,
} from '@dotli/config';

/** Whether the protocol frame advertises the chain of `genesisHash` as one it serves. */
export function isRemoteChainSupported(genesisHash: string): boolean {
  // Gateway mode bridges a curated RPC subset, while smoldot can run any configured chain.
  const supported = hasLightClient(getBackend())
    ? getActiveSupportedGenesisHashes()
    : getActiveGatewaySupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}
