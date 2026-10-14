// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settings persistence, origin wipes and the reload into debug mode. Imports no Solid and loads eagerly because the
// host's boot resets through it when a URL changes the settings, before any island has loaded.

import { captureException, m, reportExpected, spans as S } from '@dotli/metrics';
import { errorName, log, pageLocalStorage, pageSessionStorage, type SafeStorage } from '@dotli/shared';
import { markContinuation, type Continuation } from './continuation.js';
import { sharedSettingsOf, writeLocalSettings, writeSettingsToSearch, type Settings } from '@dotli/config';
import { clearCidCache, clearBlockCache } from '@dotli/storage';
import { isDebugModeOn, leaveDebugMode } from '@dotli/truapi-debug';

import { schedulePendingReset, type PendingResetTarget } from './runtime/pending-reset.js';
import { writeSharedSettings } from './runtime/shared-mode.js';
import { THEME_KEY } from './theme-controller.js';

/** Each step reports its own failures and resolves, so a rejection here is a fault `applyAndReset` reports. */
export interface SettingsActionsDeps {
  /** Resolves false when the clear failed. It has reported that itself. */
  clearCidCache: () => Promise<boolean>;
  clearBlockCache: () => Promise<boolean>;
  /** Resolves the parts that failed, which it has reported itself. */
  wipeOrigin: () => Promise<readonly WipeFailure[]>;
  schedulePendingReset: (targets: readonly PendingResetTarget[]) => void;
  /** Reloads the page, telling the next boot why. */
  reload: (reason: Continuation) => void;
  /** Stores the settings on this origin and for the other subdomains, so the reload boots with them. */
  save: (settings: Settings) => void;
  /** The page URL, which carries the settings into the reload. */
  url: SettingsUrl;
}

export interface SettingsUrl {
  read: () => Pick<Location, 'pathname' | 'search' | 'hash'>;
  /** Swaps the URL in place, without a navigation or a history entry. */
  replace: (url: string) => void;
}

export interface ApplyOptions {
  /** Clears every cache, whatever the settings say. */
  forceFullWipe?: boolean;
  /** Why the page reloads, for the next boot's telemetry. `settings_change` unless given. */
  reason?: Continuation;
}

export interface SettingsActions {
  /**
   * Deletes only caches the user just turned off. The persisted `skipWorkerCache` flag makes the protocol
   * iframe purge itself on its next boot. Settings persist before the deletes so the reload boots with them. Never
   * rejects: a step that fails is counted, and the rest of the reset and the reload still run. The reload carries
   * `reason`.
   */
  applyAndReset: (next: Settings, prior: Settings, options?: ApplyOptions) => Promise<void>;
}

type ApplyStep = 'wipe' | 'cid_cache' | 'block_cache' | 'pending_reset';

export function createSettingsActions(deps: SettingsActionsDeps): SettingsActions {
  async function apply(next: Settings, prior: Settings, forceFullWipe: boolean): Promise<void> {
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
      deps.save(next);
      // Forces the cross-origin frames to purge regardless of their persisted prefs.
      try {
        deps.schedulePendingReset(['protocol', 'sandbox']);
      } catch (err: unknown) {
        // No session storage, as in a private window, is the browser's limit rather than a fault.
        fail('pending_reset', { err, message: '[dot.li settings] purge request not stored:' });
      }
    } else {
      deps.save(next);
      if (next.cache.skipCidCache && !prior.cache.skipCidCache && !(await deps.clearCidCache())) {
        fail('cid_cache');
      }
      if (next.cache.skipArchiveCache && !prior.cache.skipArchiveCache && !(await deps.clearBlockCache())) {
        fail('block_cache');
      }
    }

    // The URL carries the settings too, so the reload boots with them. Defaults drop off.
    const location = deps.url.read();
    const search = new URLSearchParams(location.search);
    if (writeSettingsToSearch(next, search)) {
      const query = search.toString();
      deps.url.replace(`${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    }
    if (failed.length === 0) {
      m.count(S.SETTINGS_APPLY, { outcome: 'ok' });
    }
  }

  return {
    async applyAndReset(next, prior, { forceFullWipe = false, reason = 'settings_change' } = {}) {
      try {
        await apply(next, prior, forceFullWipe);
      } catch (err: unknown) {
        captureException(err, { flow: 'ui', step: 'settings_apply' });
        log.error('[dot.li settings] Save & Apply failed:', err);
        m.count(S.SETTINGS_APPLY, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
      } finally {
        // The settings the user chose take effect only on the reload, so it runs whatever failed.
        deps.reload(reason);
      }
    },
  };
}

/** Stores `settings` on this origin and for the other subdomains, so the next boot reads them. */
function saveSettings(settings: Settings): void {
  writeLocalSettings(settings, pageLocalStorage);
  writeSharedSettings(sharedSettingsOf(settings));
}

/** This page's, which reloads it. */
export const pageSettingsActions: SettingsActions = createSettingsActions({
  clearCidCache,
  clearBlockCache,
  wipeOrigin: wipeOriginState,
  schedulePendingReset,
  reload: reason => {
    markContinuation(reason);
    window.location.reload();
  },
  save: saveSettings,
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
  local: SafeStorage;
  session: SafeStorage;
}

const BROWSER_WIPE_PARTS: WipeParts = {
  indexedDb: deleteAllIndexedDBs,
  cacheStorage: deleteAllCacheStorage,
  serviceWorkers: unregisterAllServiceWorkers,
  local: pageLocalStorage,
  session: pageSessionStorage,
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
  parts.session.clear();
  const preserved = PRESERVED_KEYS.map(key => [key, parts.local.getItem(key)] as const);
  parts.local.clear();
  for (const [key, value] of preserved) {
    if (value !== null) {
      parts.local.setItem(key, value);
    }
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
