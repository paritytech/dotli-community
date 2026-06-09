// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Chain provider factory.
//
// Maps well-known genesis hashes to smoldot chain specs and creates
// JsonRpcProviders on demand. For Asset Hub Paseo and the Paseo relay
// chain, providers are shared with the resolver via the broker. This
// avoids spinning up duplicate parachain instances in smoldot and
// ensures dApp connections are immediately usable (the resolver's
// chain is already synced by the time a dApp loads).

import { getSmProvider } from "polkadot-api/sm-provider";
import type { JsonRpcProvider } from "polkadot-api";
import {
  getActiveServicesConfig,
  getActiveSupportedGenesisHashes,
} from "@dotli/config/network";
import { log } from "@dotli/shared/log";

import {
  getDappAssetHubProvider,
  getBulletinChain,
  getPeopleChain,
  makeNonRemovingChain,
  getRelayChain,
} from "./smoldot";

export function isChainSupported(genesisHash: string): boolean {
  return getActiveSupportedGenesisHashes().has(genesisHash.toLowerCase());
}

/**
 * Create a JsonRpcProvider for a given genesis hash.
 *
 * Reuses the resolver's shared chains. The ChainBroker provides session
 * isolation so dApp connections cannot interfere with the resolver.
 * This means no duplicate parachain sync: the resolver's Asset Hub is
 * already synced by the time a dApp loads, so chain queries work immediately.
 */
export function createChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const key = genesisHash.toLowerCase();
  const cfg = getActiveServicesConfig();

  if (key === cfg.assethub.genesis.toLowerCase()) {
    log.warn("[dot.li chains] Returning shared Asset Hub provider");
    return getDappAssetHubProvider();
  }

  if (key === cfg.relay.genesis.toLowerCase()) {
    log.warn("[dot.li chains] Returning shared relay chain provider");
    return getSmProvider(() =>
      getRelayChain().then((chain) => makeNonRemovingChain(chain)),
    );
  }

  if (key === cfg.bulletin.genesis.toLowerCase()) {
    log.warn("[dot.li chains] Returning Bulletin Paseo provider (smoldot)");
    return getSmProvider(() =>
      getBulletinChain().then((chain) => makeNonRemovingChain(chain)),
    );
  }

  if (key === cfg.people.genesis.toLowerCase()) {
    log.warn("[dot.li chains] Returning People Paseo provider (smoldot)");
    return getSmProvider(() =>
      getPeopleChain().then((chain) => makeNonRemovingChain(chain)),
    );
  }

  log.warn(`[dot.li chains] Unsupported chain: ${genesisHash}`);
  return null;
}
