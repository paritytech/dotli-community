// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings a page runs with: the network, the chain backend and the cache switches. Per setting the link wins, then
// the cross-subdomain store, then this origin's storage, then the default. The network never leaves this origin, as
// every link carries it.

import { BACKEND_KEY, getDefaultBackend, hasSharedWorker, parseBackend, type Backend } from './backend.js';
import { CACHE_KEY, parseCacheSettings, type CacheSettings } from './cacheSettings.js';
import { getDefaultNetwork, getEnabledNetworks } from './getEnabledNetworks.js';
import { NETWORK_KEY, isValidNetwork, type Network } from './networkNames.js';
import type { ParsedUrlSettings } from './urlSettings.js';

export type Settings = {
  network: Network;
  backend: Backend;
  cache: CacheSettings;
};

/** The backend and cache values the cross-subdomain store holds, unparsed. */
export type SharedSettings = {
  backend: string | null;
  cache: string | null;
};

export type ResolvedSettings = {
  settings: Settings;
  /** The shared light client was chosen and this browser cannot start it, so the light client per tab stands in. */
  sharedWorkerFallback: boolean;
};

export type SettingsSources = {
  /** This origin's storage. */
  local: Pick<Storage, 'getItem'>;
  /** Null when the cross-subdomain store could not be read, or has not been yet. */
  shared: SharedSettings | null;
  /** The link's settings. */
  url?: ParsedUrlSettings;
  /** Whether this browser can start the SharedWorker the shared light client runs in. */
  sharedWorkerAvailable: boolean;
  /**
   * Whether this origin's choice wins: on localhost, whose shared store is the local server's, so test workers stay
   * apart.
   */
  preferLocal?: boolean;
};

/** Resolves each setting from the link, then the cross-subdomain store, then this origin's storage, then the default. */
export function resolveSettings({
  local,
  shared,
  url,
  sharedWorkerAvailable,
  preferLocal = false,
}: SettingsSources): ResolvedSettings {
  // On localhost the shared backend never applies, so a fresh origin starts on the default and parallel test workers
  // stay apart. A cache this origin never chose still follows the shared one.
  const wanted =
    url?.backend ??
    parseBackend(preferLocal ? null : (shared?.backend ?? null)) ??
    parseBackend(local.getItem(BACKEND_KEY)) ??
    getDefaultBackend();
  const sharedWorkerFallback = hasSharedWorker(wanted) && !sharedWorkerAvailable;
  const ownCache = local.getItem(CACHE_KEY);
  const cache = parseCacheSettings(preferLocal ? (ownCache ?? shared?.cache ?? null) : (shared?.cache ?? ownCache));
  return {
    settings: {
      network: chooseNetwork(url?.network ?? null, local.getItem(NETWORK_KEY)),
      backend: sharedWorkerFallback ? 'smoldot-direct' : wanted,
      cache: {
        skipCidCache: url?.skipCidCache ?? cache.skipCidCache,
        skipArchiveCache: url?.skipArchiveCache ?? cache.skipArchiveCache,
        skipWorkerCache: url?.skipWorkerCache ?? cache.skipWorkerCache,
      },
    },
    sharedWorkerFallback,
  };
}

/** The link's network, else the stored one, while this build still offers it, else the default. */
function chooseNetwork(fromUrl: Network | null, stored: string | null): Network {
  const enabled = getEnabledNetworks();
  if (fromUrl !== null && enabled.includes(fromUrl)) {
    return fromUrl;
  }
  if (stored !== null && isValidNetwork(stored) && enabled.includes(stored)) {
    return stored;
  }
  return getDefaultNetwork();
}
