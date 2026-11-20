// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settings persistence and the reset that applies them. Imports no Solid and loads eagerly because the host's boot
// resets through it when a URL changes the settings, before any island has loaded.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool, pageLocalStorage } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';
import { markAndReload, type Continuation } from '../../kit/createContinuation.js';
import {
  getSettings,
  getSharedSettings,
  writeLocalSettings,
  writeSettingsToSearch,
  type Backend,
  type Settings,
} from '@dotli/config';
import { blockCache, cidCache } from '@dotli/storage';

import { isResetRunning, type SettingsResetStatus } from './settings.js';
import { pendingResets, type PendingResetTarget } from '../../kit/createPendingResets.js';
import { settleSharedWrites, writeSharedSettings } from '../../kit/sharedMode.js';
import { wipeOriginState, type WipeFailure } from './wipeOriginState.js';

const storageReport = createReporter({ flow: 'storage' });
const uiReport = createReporter({ flow: 'ui' });

/**
 * One settings reset: Save & Apply or Clear all in the settings, a link that changes a saved choice, or a backend
 * switch, counted once. Tagged `outcome` and, on error, `reason` (the first step that failed: `wipe`,
 * `cid_cache`, `block_cache` or `pending_reset`, or `fault` for a step that threw), as the reload follows either way.
 */
const settingsApplyMetric = defineCount<'error' | 'ok'>('settings.apply');

/** Each step reports its own failures and resolves, so a rejection here is a fault `applyAndReset` reports. */
export type SettingsActionsParams = {
  /** Resolves false when the clear failed. It has reported that itself. */
  clearCidCache: () => Promise<boolean>;
  /** Resolves false when the clear failed. It has reported that itself. */
  clearBlockCache: () => Promise<boolean>;
  /** Resolves the parts that failed, which it has reported itself. */
  wipeOrigin: () => Promise<readonly WipeFailure[]>;
  /** Asks `targets` to purge on their next boot. Throws when the request cannot be stored. */
  schedulePendingReset: (targets: readonly PendingResetTarget[]) => void;
  /** Reloads the page, telling the next boot why. */
  reload: (reason: Continuation) => void;
  /** Stores the settings on this origin and for the other subdomains, so the reload boots with them. */
  save: (settings: Settings) => void;
  /** Resolves once the settings written for the other subdomains are stored or failed. Never rejects. */
  settleSharedWrites: () => Promise<void>;
  /** The page URL, which carries the settings into the reload. */
  url: SettingsUrl;
  /** The settings a backend switch keeps, this context's own unless given. */
  readSettings?: () => Settings;
};

type SettingsUrl = {
  /** Returns the page URL's path, query and fragment. Must not throw. */
  read: () => Pick<Location, 'pathname' | 'search' | 'hash'>;
  /** Swaps the URL in place, without a navigation or a history entry. Must not throw. */
  replace: (url: string) => void;
};

type ApplyAndResetParams = {
  /** Clears every cache, whatever the settings say. */
  forceFullWipe?: boolean;
  /** Why the page reloads, for the next boot's telemetry. `settings_change` unless given. */
  reason?: Continuation;
};

export type SettingsActions = ReturnType<typeof createSettingsActions>;

type ApplyStep = 'wipe' | 'cid_cache' | 'block_cache' | 'pending_reset';

/** Builds the settings actions over the given steps. */
export function createSettingsActions({
  clearCidCache,
  clearBlockCache,
  wipeOrigin,
  schedulePendingReset,
  reload,
  save,
  settleSharedWrites: settleShared,
  url,
  readSettings = getSettings,
}: SettingsActionsParams) {
  const resetStatus = atom<SettingsResetStatus>('idle');
  const reset: ReadableAtom<SettingsResetStatus> = resetStatus;
  // One reset at a time, so a call made during a reset waits for it, then finds it started.
  const resets = createAsyncTaskPool({ poolSize: 1 });

  function applyAndReset(
    next: Settings,
    prior: Settings,
    { forceFullWipe = false, reason = 'settings_change' }: ApplyAndResetParams = {},
  ): Promise<void> {
    return resets.call(async () => {
      // A reset ends in a reload, so one that started never runs again.
      if (isResetRunning(resetStatus.get())) {
        return;
      }
      resetStatus.set(forceFullWipe ? 'clearing' : 'applying');
      try {
        await (forceFullWipe ? wipeAndSave(next) : saveAndClear(next, prior));
      } catch (error: unknown) {
        // The reset's one count, as a throw ends its steps before they count it. The error's class is in the capture.
        uiReport.defect(error, {
          step: 'settings_apply',
          metric: settingsApplyMetric,
          message: '[dot.li settings] Save & Apply failed:',
          reason: 'fault',
        });
      } finally {
        // The unload would drop a write for the other subdomains still on its way.
        await settleShared();
        // The settings the user chose take effect only on the reload, so it runs whatever failed.
        reload(reason);
      }
    });
  }

  function switchBackend(next: Backend): Promise<void> {
    const settings = readSettings();
    return applyAndReset({ ...settings, backend: next }, settings, { reason: 'switch_backend' });
  }

  /** Wipes every cache, then saves, since the wipe would erase the saved settings. Counts the reset once. */
  async function wipeAndSave(next: Settings): Promise<void> {
    const failed: ApplyStep | null = (await wipeOrigin()).length > 0 ? 'wipe' : null;
    save(next);
    writeSettingsToUrl(next);
    try {
      // Forces the cross-origin frames to purge regardless of their persisted prefs.
      schedulePendingReset(['protocol', 'sandbox']);
    } catch (error: unknown) {
      // No session storage, as in a private window, is the browser's limit rather than a fault. This report is the
      // reset's count, under the first step that failed.
      storageReport.expected(error, {
        step: 'settings_apply',
        metric: settingsApplyMetric,
        reason: failed ?? 'pending_reset',
        message: '[dot.li settings] purge request not stored:',
      });
      return;
    }
    countReset(failed);
  }

  /** Saves, then deletes only the caches the user just turned off. Counts the reset once. */
  async function saveAndClear(next: Settings, prior: Settings): Promise<void> {
    save(next);
    let failed: ApplyStep | null = null;
    if (next.cache.skipCidCache && !prior.cache.skipCidCache && !(await clearCidCache())) {
      failed = 'cid_cache';
    }
    if (next.cache.skipArchiveCache && !prior.cache.skipArchiveCache && !(await clearBlockCache())) {
      failed ??= 'block_cache';
    }
    writeSettingsToUrl(next);
    countReset(failed);
  }

  /** Counts the reset under the first step that failed, which reported its failure itself, or as ok. */
  function countReset(failed: ApplyStep | null): void {
    settingsApplyMetric.count(failed === null ? { outcome: 'ok' } : { outcome: 'error', reason: failed });
  }

  /** Writes `settings` into the page URL, which carries them into the reload too. Defaults drop off. */
  function writeSettingsToUrl(settings: Settings): void {
    const location = url.read();
    const search = new URLSearchParams(location.search);
    if (writeSettingsToSearch(settings, search)) {
      const query = search.toString();
      url.replace(`${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    }
  }

  return {
    /**
     * Applies `next` over `prior` and reloads. A save stores the settings, then deletes only the caches the user just
     * turned off. A full wipe deletes every cache, then stores the settings and asks the other origins to purge on
     * their next boot. The reload carries `reason`. Rejects only as `reload` throws: a step that fails is counted, and
     * the rest of the reset and the reload still run. A call while a reset runs saves and reloads nothing, and
     * resolves once the running one settles.
     */
    applyAndReset,
    /**
     * Applies the active settings with `next` as their backend, as Save does without clearing anything, and reloads
     * onto it. Rejects as `applyAndReset` does.
     */
    switchBackend,
    /** The running reset, `idle` until one starts. It never returns to `idle`, since the reload follows. */
    reset,
  };
}

/** This page's, which reloads it. */
export const pageSettingsActions: SettingsActions = createSettingsActions({
  clearCidCache: cidCache.clear,
  clearBlockCache: blockCache.clear,
  wipeOrigin: wipeOriginState,
  schedulePendingReset: pendingResets.schedule,
  reload: markAndReload,
  save: saveSettings,
  settleSharedWrites,
  url: {
    read: () => window.location,
    replace(url) {
      window.history.replaceState(null, '', url);
    },
  },
});

/** Stores `settings` on this origin and for the other subdomains, so the next boot reads them. */
function saveSettings(settings: Settings): void {
  writeLocalSettings(settings, pageLocalStorage);
  void writeSharedSettings(getSharedSettings(settings));
}
