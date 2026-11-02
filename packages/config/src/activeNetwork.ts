// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The active network and the readers of its config.

import { activeSettings } from './activeSettings.js';
import { getDefaultNetwork } from './getEnabledNetworks.js';
import type { Network } from './networkNames.js';
import { BUILTIN_NETWORK_SERVICES, NETWORK_NAME_TO_SERVICES_CONFIG } from './networkServices.js';
import type { ChainService, FixedServicesConfig, ServicesConfig } from './types.js';

/** This context's network, or the default before it is set. */
export function getNetwork(): Network {
  return activeSettings()?.network ?? getDefaultNetwork();
}

/**
 * The active TLD with its leading dot.
 * Each TLD must also be in truapi-platform's `DOTNS_TLDS`, or the core cannot load a product under it.
 */
export function getActiveTldSuffix(): string {
  return getTldSuffix(getNetwork());
}

/** Appends the active TLD to a bare label, giving `myapp.paseo`. */
export function withActiveTld(label: string): string {
  return `${label}${getActiveTldSuffix()}`;
}

export function getActiveServicesConfig(): ServicesConfig {
  return NETWORK_NAME_TO_SERVICES_CONFIG[getNetwork()];
}

/** The active network's fields no override can change, for a context that never sees the runtime config. */
export function getActiveFixedServicesConfig(): FixedServicesConfig {
  return BUILTIN_NETWORK_SERVICES[getNetwork()];
}

/** Genesis hashes dApps may target on the active network. No override changes a genesis, so a worker may read it. */
export function getActiveSupportedGenesisHashes(): Set<string> {
  const cfg = getActiveFixedServicesConfig();
  return new Set(
    [cfg.relay.genesis, cfg.assethub.genesis, cfg.bulletin.genesis, cfg.people.genesis].map(h => h.toLowerCase()),
  );
}

/**
 * Chains advertised to dApps in rpc-gateway mode: those of `cfg` with an RPC endpoint. Bulletin is excluded because its
 * content is served through IPFS gateways. This is advertisement, not access control.
 */
export function getActiveGatewayChains(cfg: ServicesConfig = getActiveServicesConfig()): ChainService[] {
  return [cfg.relay, cfg.assethub, cfg.people].filter(c => c.rpcs.length > 0);
}

/** Genesis hashes (lowercased) advertised to dApps in RPC-gateway mode. */
export function getActiveGatewaySupportedGenesisHashes(): Set<string> {
  return new Set(getActiveGatewayChains().map(c => c.genesis.toLowerCase()));
}

/** Genesis hashes (lowercased) the core gateway seam can serve. */
export function getActiveCoreGatewaySupportedGenesisHashes(): Set<string> {
  return new Set(getActiveCoreGatewayChains().map(c => c.genesis.toLowerCase()));
}

/** Gateway chains accepted by the shared Rust-core connection callback. */
export function getActiveCoreGatewayChains(): ChainService[] {
  const cfg = getActiveServicesConfig();
  return [...getActiveGatewayChains(), cfg.bulletin].filter(chain => chain.rpcs.length > 0);
}

/** The TLD `network` registers names under, with its leading dot. */
function getTldSuffix(network: Network): string {
  return `.${NETWORK_NAME_TO_SERVICES_CONFIG[network].dotns.TLD}`;
}
