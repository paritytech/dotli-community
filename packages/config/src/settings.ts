// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings a page runs with: the network, the chain backend and the cache switches. Per setting the link wins, then
// the cross-subdomain store, then this origin's storage, then the default. The network never leaves this origin, as
// every link carries it.

import {
  BACKEND_KEY,
  CACHE_KEY,
  LEGACY_KEYS,
  defaultBackend,
  legacyBackend,
  parseBackend,
  parseCacheSettings,
  type Backend,
  type CacheSettings,
  getBackend,
  getCacheSettings,
} from './mode.js';
import {
  NETWORK_KEY,
  defaultNetwork,
  getEnabledNetworks,
  getNetwork,
  isValidNetwork,
  type Network,
} from './network.js';
import { setSettings } from './active-settings.js';
import type { ParsedUrlSettings } from './url-settings.js';

export interface Settings {
  network: Network;
  backend: Backend;
  cache: CacheSettings;
}

/** The backend and cache values the cross-subdomain store holds, unparsed. */
export interface SharedSettings {
  backend: string | null;
  cache: string | null;
}

export interface SettingsSources {
  /** This origin's storage. */
  local: Pick<Storage, 'getItem'>;
  /** Null when the cross-subdomain store could not be read, or has not been yet. */
  shared: SharedSettings | null;
  /** The link's settings. */
  url?: ParsedUrlSettings;
  /** Whether this browser can start the SharedWorker the shared light client runs in. */
  sharedWorkerAvailable: boolean;
  /** Each `*.localhost` origin is its own site, where this origin's choice wins so parallel test workers stay apart. */
  preferLocal?: boolean;
}

/** Resolves each setting from the link, then the cross-subdomain store, then this origin's storage, then the default. */
export function resolveSettings({
  local,
  shared,
  url,
  sharedWorkerAvailable,
  preferLocal = false,
}: SettingsSources): Settings {
  // On localhost the shared backend never applies, so a fresh origin starts on the default and parallel test workers
  // stay apart. A cache this origin never chose still follows the shared one.
  const wanted =
    url?.chainBackend ??
    parseBackend(preferLocal ? local.getItem(BACKEND_KEY) : (shared?.backend ?? local.getItem(BACKEND_KEY))) ??
    legacyBackend(local) ??
    defaultBackend();
  const ownCache = local.getItem(CACHE_KEY);
  const cache = parseCacheSettings(preferLocal ? (ownCache ?? shared?.cache ?? null) : (shared?.cache ?? ownCache));
  return {
    network: chooseNetwork(url?.network ?? null, local.getItem(NETWORK_KEY)),
    backend: wanted === 'smoldot-shared-worker' && !sharedWorkerAvailable ? 'smoldot-direct' : wanted,
    cache: {
      skipCidCache: url?.skipCidCache ?? cache.skipCidCache,
      skipArchiveCache: url?.skipArchiveCache ?? cache.skipArchiveCache,
      skipWorkerCache: url?.skipWorkerCache ?? cache.skipWorkerCache,
    },
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
  return defaultNetwork();
}

/** Stores `settings` on this origin, where an old build's keys give way to them. */
export function writeLocalSettings(settings: Settings, local: Pick<Storage, 'setItem' | 'removeItem'>): void {
  local.setItem(NETWORK_KEY, settings.network);
  local.setItem(BACKEND_KEY, settings.backend);
  local.setItem(CACHE_KEY, JSON.stringify(settings.cache));
  for (const key of LEGACY_KEYS) {
    local.removeItem(key);
  }
}

/** What the cross-subdomain store keeps of `settings`. */
export function sharedSettingsOf(settings: Settings): SharedSettings {
  return { backend: settings.backend, cache: JSON.stringify(settings.cache) };
}

/** Whether this origin holds a choice from an earlier visit. Read it before the boot stores this visit's. */
export function hasStoredSettings(local: Pick<Storage, 'getItem'>): boolean {
  return [NETWORK_KEY, BACKEND_KEY, CACHE_KEY].some(key => local.getItem(key) !== null);
}

/** Sets the network this context runs on. A context that only reads the link's network has no other setting to give. */
export function setActiveNetwork(network: Network): void {
  setSettings({ ...getSettings(), network });
}

/** This context's settings, each the default until set. */
export function getSettings(): Settings {
  return { network: getNetwork(), backend: getBackend(), cache: getCacheSettings() };
}
