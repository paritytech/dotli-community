// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveFixedServicesConfig, getActiveServicesConfig } from './activeNetwork.js';

/**
 * The four chains, named by what they do for the visitor. Every package names a chain by its role.
 */
export type ChainRole = 'relay' | 'assethub' | 'bulletin' | 'people';

/** Every chain role, in the order a visitor should read them. */
export const CHAIN_ROLES: readonly ChainRole[] = ['relay', 'assethub', 'bulletin', 'people'];

/** What the visitor is told each chain is for. */
export const CHAIN_ROLE_LABELS: Record<ChainRole, string> = {
  relay: 'Relay',
  assethub: 'Hub',
  bulletin: 'Storage',
  people: 'Identity',
};

export type ActiveChainRole = {
  readonly role: ChainRole;
  readonly label: string;
  readonly genesis: string;
  readonly blockTimeMs: number;
  /** False when the active network has no endpoint for this chain. */
  readonly hasEndpoint: boolean;
};

/** Every chain of the active network, in the order a visitor should read them. */
export function getActiveChainRoles(): ActiveChainRole[] {
  const cfg = getActiveServicesConfig();
  return CHAIN_ROLES.map(role => {
    const service = cfg[role];
    return {
      role,
      label: CHAIN_ROLE_LABELS[role],
      genesis: service.genesis,
      blockTimeMs: service.blockTimeMs,
      hasEndpoint: service.rpcs.length > 0,
    };
  });
}

/**
 * Which role a genesis hash belongs to, or null when it is not ours. No override changes a genesis, so a worker may
 * read it.
 */
export function getChainRoleForGenesis(genesisHash: string): ChainRole | null {
  const key = genesisHash.toLowerCase();
  const config = getActiveFixedServicesConfig();
  return CHAIN_ROLES.find(role => config[role].genesis.toLowerCase() === key) ?? null;
}
