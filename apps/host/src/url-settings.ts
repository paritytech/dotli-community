// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settings a link carries. Per setting, the URL beats the shared store, which beats localStorage and the default.

import {
  BACKEND_KEY,
  CACHE_KEY,
  NETWORK_KEY,
  getBackend,
  getCacheSettings,
  getNetwork,
  isSharedWorkerAvailable,
  localStorageAdapter,
  parseSettingsFromSearch,
  setBackend,
  setCacheSettings,
  setNetwork,
  writeSettingsToSearch,
  type ModeStorage,
} from '@dotli/config';
import { reportExpected, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { ShowNotification } from '@dotli/ui-widgets';
import type { SettingsActions } from './settings-actions.js';

const bootLog = log.child({ flow: 'boot' });

/** What this origin had persisted before anything read the settings. */
export interface PersistedSettings {
  hadPriorPersisted: boolean;
  rawPersistedBackend: string | null;
}

/**
 * Raw reads, taken before `persistDefaults` stores the defaults and makes every fresh visit look persisted. They read
 * this origin's localStorage, and get null where Safari private mode throws.
 */
export function readPersistedSettings(local: Pick<ModeStorage, 'getItem'> = localStorageAdapter): PersistedSettings {
  const rawPersistedBackend = local.getItem(BACKEND_KEY);
  return {
    hadPriorPersisted:
      local.getItem(NETWORK_KEY) !== null || rawPersistedBackend !== null || local.getItem(CACHE_KEY) !== null,
    rawPersistedBackend,
  };
}

export interface UrlSettingsDeps {
  /** The page's query string. */
  search: string;
  /** Configures the protocol frame from the settings in force now. */
  configureFrame: () => void;
  bootstrapSharedMode: () => Promise<void>;
  /** Wipes and reloads when the link displaces a saved choice, as Save does. */
  actions: Pick<SettingsActions, 'applyAndReset'>;
  notify: ShowNotification;
  /** Replaces the page's query string without a navigation. */
  replaceSearch: (query: string) => void;
}

/** Applies the link's settings. A URL value that displaces a persisted choice wipes and reloads, as Save does. */
export async function applyUrlSettings(
  { hadPriorPersisted, rawPersistedBackend }: PersistedSettings,
  deps: UrlSettingsDeps,
): Promise<void> {
  const search = new URLSearchParams(deps.search);
  const parsed = parseSettingsFromSearch(search);

  const rawUrlBackend = search.get('chainBackend');
  const sharedWorkerFallback =
    !isSharedWorkerAvailable() &&
    (rawUrlBackend === 'smoldot-shared-worker' || rawPersistedBackend === 'smoldot-shared-worker');

  // The shared store is read through the frame, so the frame boots with this origin's own settings. `startHost`
  // configures it again once the URL and shared settings apply, and a change rebuilds it.
  deps.configureFrame();

  // Before reading prior values, so they reflect the cross-subdomain store and the writes below mirror to it.
  try {
    await deps.bootstrapSharedMode();
  } catch (err: unknown) {
    // Its chunk missing after a deploy, or a store it cannot reach, is the environment's fault, and the page goes on
    // with this origin's settings.
    bootLog.warn('[dot.li] Shared mode bootstrap could not run, continuing with per-origin localStorage:', err);
    reportExpected(err, { flow: 'boot', step: 'shared_mode_bootstrap', metric: S.SHARED_MODE_BOOTSTRAP });
  }

  const prior = {
    network: getNetwork(),
    chain: getBackend(),
    cache: getCacheSettings(),
  };

  const next = {
    network: parsed.network ?? prior.network,
    chain: parsed.chainBackend ?? prior.chain,
    cache: {
      skipArchiveCache: parsed.skipArchiveCache ?? prior.cache.skipArchiveCache,
      skipCidCache: parsed.skipCidCache ?? prior.cache.skipCidCache,
      skipWorkerCache: parsed.skipWorkerCache ?? prior.cache.skipWorkerCache,
    },
  };

  setNetwork(next.network);
  setBackend(next.chain);
  setCacheSettings(next.cache);

  if (writeSettingsToSearch({ network: next.network, chainBackend: next.chain, cache: next.cache }, search)) {
    deps.replaceSearch(search.toString());
  }

  if (sharedWorkerFallback) {
    deps.notify({
      label: 'Light client shared unavailable',
      text: "This browser doesn't support Light client shared. Falling back to Light client per tab.",
      tone: 'warn',
      dismissMs: 5_000,
    });
  }

  const changed =
    next.network !== prior.network ||
    next.chain !== prior.chain ||
    next.cache.skipArchiveCache !== prior.cache.skipArchiveCache ||
    next.cache.skipCidCache !== prior.cache.skipCidCache ||
    next.cache.skipWorkerCache !== prior.cache.skipWorkerCache;

  // A fresh origin has nothing stale, and a URL that matches localStorage changes nothing.
  if (!changed || !hadPriorPersisted) {
    return;
  }

  // The other two origins purge themselves on their next boot.
  await deps.actions.applyAndReset(next, prior, { forceFullWipe: true });
}
