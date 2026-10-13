// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settings persistence, origin wipes and the reload into debug mode. Imports no Solid and loads eagerly because the
// host's boot resets through it when a URL changes the settings, before any island has loaded.

import { captureException, m, reportExpected, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';
import { markContinuation } from './continuation.js';
import {
  setCacheSettings,
  setBackend,
  type Backend,
  type CacheSettings,
  setNetwork,
  type Network,
  writeSettingsToSearch,
} from '@dotli/config';
import { clearCidCache, clearBlockCache } from '@dotli/storage';
import { isDebugModeOn, leaveDebugMode } from '@dotli/truapi-debug';

import { schedulePendingReset, type PendingResetTarget } from '@dotli/host-runtime';
import { THEME_KEY } from './theme-controller.js';

/** Nothing is persisted until Save & Apply, and closing the popover discards the draft. */
export interface ModeDraft {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
}

/** Each step reports its own failures and resolves, so a rejection here is a fault `applyAndReset` reports. */
export interface SettingsActionsDeps {
  /** Resolves false when the clear failed. It has reported that itself. */
  clearCidCache: () => Promise<boolean>;
  clearBlockCache: () => Promise<boolean>;
  /** Resolves the parts that failed, which it has reported itself. */
  wipeOrigin: () => Promise<readonly WipeFailure[]>;
  schedulePendingReset: (targets: readonly PendingResetTarget[]) => void;
  reload: () => void;
  /** The page URL, which carries the settings into the reload. */
  url: SettingsUrl;
}

export interface SettingsUrl {
  read: () => Pick<Location, 'pathname' | 'search' | 'hash'>;
  /** Swaps the URL in place, without a navigation or a history entry. */
  replace: (url: string) => void;
}

export interface SettingsActions {
  /**
   * Deletes only caches the user just turned off. The persisted `skipWorkerCache` flag makes the protocol
   * iframe purge itself on its next boot. Settings persist before the deletes so the reload boots with them. Never
   * rejects: a step that fails is counted, and the rest of the reset and the reload still run.
   */
  applyAndReset: (draft: ModeDraft, prior: ModeDraft, options?: { forceFullWipe?: boolean }) => Promise<void>;
}

type ApplyStep = 'wipe' | 'cid_cache' | 'block_cache' | 'pending_reset';

function persist(draft: ModeDraft): void {
  setBackend(draft.chain);
  setNetwork(draft.network);
  setCacheSettings(draft.cache);
}

export function createSettingsActions(deps: SettingsActionsDeps): SettingsActions {
  async function apply(draft: ModeDraft, prior: ModeDraft, forceFullWipe: boolean): Promise<void> {
    const failed: ApplyStep[] = [];
    /** `expected` is the environment failure this step caught, left as a breadcrumb and a warning beside its count. */
    const fail = (step: ApplyStep, expected?: { err: unknown; message: string }): void => {
      failed.push(step);
      if (expected === undefined) {
        m.count(S.SETTINGS_APPLY, { outcome: 'error', reason: step });
        return;
      }
      reportExpected(expected.err, {
        flow: 'storage',
        step: 'settings_apply',
        metric: S.SETTINGS_APPLY,
        reason: step,
        message: expected.message,
      });
    };

    if (forceFullWipe) {
      if ((await deps.wipeOrigin()).length > 0) {
        fail('wipe');
      }
      persist(draft);
      // Forces the cross-origin frames to purge regardless of their persisted prefs.
      try {
        deps.schedulePendingReset(['protocol', 'sandbox']);
      } catch (err: unknown) {
        // No session storage, as in a private window, is the browser's limit rather than a fault.
        fail('pending_reset', { err, message: '[dot.li settings] purge request not stored:' });
      }
    } else {
      persist(draft);
      if (draft.cache.skipCidCache && !prior.cache.skipCidCache && !(await deps.clearCidCache())) {
        fail('cid_cache');
      }
      if (draft.cache.skipArchiveCache && !prior.cache.skipArchiveCache && !(await deps.clearBlockCache())) {
        fail('block_cache');
      }
    }

    // The URL carries the settings too, so the reload boots with them. Defaults drop off.
    const location = deps.url.read();
    const search = new URLSearchParams(location.search);
    if (writeSettingsToSearch({ network: draft.network, chainBackend: draft.chain, cache: draft.cache }, search)) {
      const query = search.toString();
      deps.url.replace(`${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    }
    if (failed.length === 0) {
      m.count(S.SETTINGS_APPLY, { outcome: 'ok' });
    }
  }

  return {
    async applyAndReset(draft, prior, { forceFullWipe = false } = {}) {
      try {
        await apply(draft, prior, forceFullWipe);
      } catch (err: unknown) {
        captureException(err, { flow: 'ui', step: 'settings_apply' });
        log.error('[dot.li settings] Save & Apply failed:', err);
        m.count(S.SETTINGS_APPLY, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
      } finally {
        // The settings the user chose take effect only on the reload, so it runs whatever failed.
        markContinuation('settings_change');
        deps.reload();
      }
    },
  };
}

/** This page's, which reloads it. */
export const pageSettingsActions: SettingsActions = createSettingsActions({
  clearCidCache,
  clearBlockCache,
  wipeOrigin: wipeOriginState,
  schedulePendingReset,
  reload: () => {
    window.location.reload();
  },
  url: {
    read: () => window.location,
    replace: url => {
      window.history.replaceState(null, '', url);
    },
  },
});

/** Survive a reset, since losing the theme would be a visible change nobody requested. */
const PRESERVED_KEYS: readonly string[] = [THEME_KEY];

export type WipeFailure = 'indexeddb' | 'cache_storage' | 'service_worker';

/** The browser stores a wipe empties. Each rejects when it could not finish. */
export interface WipeParts {
  indexedDb: () => Promise<void>;
  cacheStorage: () => Promise<void>;
  serviceWorkers: () => Promise<void>;
  /** Reached inside the wipe, as the page's storage throws where the browser blocks it. */
  local: () => Storage;
  session: () => Storage;
}

const BROWSER_WIPE_PARTS: WipeParts = {
  indexedDb: deleteAllIndexedDBs,
  cacheStorage: deleteAllCacheStorage,
  serviceWorkers: unregisterAllServiceWorkers,
  local: () => localStorage,
  session: () => sessionStorage,
};

/**
 * Best-effort, since Firefox and older Safari lack `indexedDB.databases()`. Resolves the parts that failed after
 * reporting each, so the caller counts them without a second report.
 */
export async function wipeOriginState(parts: WipeParts = BROWSER_WIPE_PARTS): Promise<readonly WipeFailure[]> {
  const failed: WipeFailure[] = [];
  const run = async (reason: WipeFailure, part: () => Promise<void>): Promise<void> => {
    try {
      await part();
    } catch (err: unknown) {
      failed.push(reason);
      reportExpected(err, {
        flow: 'storage',
        step: `origin_wipe_${reason}`,
        metric: S.ORIGIN_WIPE,
        reason,
        message: `[dot.li settings] ${reason} wipe failed:`,
      });
    }
  };
  await Promise.all([run('indexeddb', parts.indexedDb), run('cache_storage', parts.cacheStorage)]);
  await run('service_worker', parts.serviceWorkers);
  try {
    parts.session().clear();
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage unavailable (Safari private mode). Full reset is best-effort; anything we can't clear just means a partial baseline.
  } catch {
    // sessionStorage unavailable.
  }
  try {
    const local = parts.local();
    const preserved = PRESERVED_KEYS.map(key => [key, local.getItem(key)] as const);
    local.clear();
    for (const [key, value] of preserved) {
      if (value !== null) {
        local.setItem(key, value);
      }
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage unavailable. Full reset is best-effort.
  } catch {
    // localStorage unavailable.
  }
  return failed;
}

async function deleteAllIndexedDBs(): Promise<void> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return;
  }
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs.map(
      db =>
        new Promise<void>(resolve => {
          if (db.name === undefined || db.name === '') {
            resolve();
            return;
          }
          const req = indexedDB.deleteDatabase(db.name);
          // Chromium may never fire success, error or blocked.
          const timer = setTimeout(resolve, 3000);
          const settle = (): void => {
            clearTimeout(timer);
            resolve();
          };
          req.onsuccess = settle;
          req.onerror = settle;
          req.onblocked = settle;
        }),
    ),
  );
}

async function deleteAllCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') {
    return;
  }
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
}

async function unregisterAllServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
}

export function isTruapiDebugEnabled(): boolean {
  return isDebugModeOn(window);
}

/** Reloads this tab with the debug panel on. */
export function openInDebugMode(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('debug', 'true');
  window.location.assign(url.toString());
}

/** Turns debug mode off for this tab and reloads it without the panel. */
export function closeDebugMode(): void {
  leaveDebugMode(window);
  window.location.reload();
}
