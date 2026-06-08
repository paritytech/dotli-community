// dot.li — Chain provider factory
//
// Maps well-known genesis hashes to smoldot chain specs and creates
// JsonRpcProviders on demand. For Asset Hub Paseo and the Paseo relay
// chain, providers are shared with the resolver via the broker — this
// avoids spinning up duplicate parachain instances in smoldot and
// ensures dApp connections are immediately usable (the resolver's
// chain is already synced by the time a dApp loads).

import { getSmProvider } from "polkadot-api/sm-provider";
import type { JsonRpcProvider } from "polkadot-api";
import {
  PASEO_RELAY_GENESIS as PASEO_RELAY,
  ASSET_HUB_PASEO_GENESIS as ASSET_HUB_PASEO,
  BULLETIN_PASEO_GENESIS as BULLETIN_PASEO,
  PEOPLE_PASEO_GENESIS as PEOPLE_PASEO,
} from "@dotli/config/config";
import { log } from "@dotli/shared/log";

import {
  getDappAssetHubProvider,
  getBulletinChain,
  getPeopleChain,
  makeNonRemovingChain,
  getRelayChain,
} from "./smoldot";

const SUPPORTED_GENESIS = new Set([
  PASEO_RELAY.toLowerCase(),
  ASSET_HUB_PASEO.toLowerCase(),
  BULLETIN_PASEO.toLowerCase(),
  PEOPLE_PASEO.toLowerCase(),
]);

export function isChainSupported(genesisHash: string): boolean {
  return SUPPORTED_GENESIS.has(genesisHash.toLowerCase());
}

/**
 * Create a JsonRpcProvider for a given genesis hash.
 *
 * Reuses the resolver's shared chains — the ChainBroker provides session
 * isolation so dApp connections cannot interfere with the resolver.
 * This means no duplicate parachain sync: the resolver's Asset Hub is
 * already synced by the time a dApp loads, so chain queries work immediately.
 */
export function createChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const key = genesisHash.toLowerCase();

  if (key === ASSET_HUB_PASEO.toLowerCase()) {
    log.warn(
      "[dot.li chains] Returning dApp Asset Hub provider (fresh chain, no shared history)",
    );
    return getDappAssetHubProvider();
  }

  if (key === PASEO_RELAY.toLowerCase()) {
    log.warn("[dot.li chains] Returning shared relay chain provider");
    return getSmProvider(() => getRelayChain());
  }

  if (key === BULLETIN_PASEO.toLowerCase()) {
    log.warn("[dot.li chains] Returning Bulletin Paseo provider (smoldot)");
    return getSmProvider(() =>
      getBulletinChain().then((chain) => makeNonRemovingChain(chain)),
    );
  }

  if (key === PEOPLE_PASEO.toLowerCase()) {
    log.warn("[dot.li chains] Returning People Paseo provider (smoldot)");
    return getSmProvider(() =>
      getPeopleChain().then((chain) => makeNonRemovingChain(chain)),
    );
  }

  log.warn(`[dot.li chains] Unsupported chain: ${genesisHash}`);
  return null;
}
