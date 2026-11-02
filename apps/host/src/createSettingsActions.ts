// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settings persistence and the reset that applies them. Imports no Solid and loads eagerly because the host's boot
// resets through it when a URL changes the settings, before any island has loaded.

import { m, reportDefect, reportExpected, spans as S } from '@dotli/metrics';
import { pageLocalStorage } from '@dotli/shared';
import { markAndReload, type Continuation } from './createContinuation.js';
import { getSharedSettings, writeLocalSettings, writeSettingsToSearch, type Settings } from '@dotli/config';
import { blockCache, cidCache } from '@dotli/storage';

import { pendingResets, type PendingResetTarget } from './runtime/createPendingResets.js';
import { writeSharedSettings } from './runtime/sharedMode.js';
import { wipeOriginState, type WipeFailure } from './wipeOriginState.js';

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
  /** The page URL, which carries the settings into the reload. */
  url: SettingsUrl;
};

export type SettingsUrl = {
  /** Returns the page URL's path, query and fragment. Never throws. */
  read: () => Pick<Location, 'pathname' | 'search' | 'hash'>;
  /** Swaps the URL in place, without a navigation or a history entry. Never throws. */
  replace: (url: string) => void;
};

type ApplyAndResetParams = {
  /** Clears every cache, whatever the settings say. */
  forceFullWipe?: boolean;
  /** Why the page reloads, for the next boot's telemetry. `settings_change` unless given. */
  reason?: Continuation;
};

type ApplyParams = {
  next: Settings;
  prior: Settings;
  forceFullWipe: boolean;
};

export type SettingsActions = ReturnType<typeof createSettingsActions>;

type ApplyStep = 'wipe' | 'cid_cache' | 'block_cache' | 'pending_reset';

/** Builds the settings actions over the given steps. Never throws. */
export function createSettingsActions({
  clearCidCache,
  clearBlockCache,
  wipeOrigin,
  schedulePendingReset,
  reload,
  save,
  url,
}: SettingsActionsParams) {
  async function apply({ next, prior, forceFullWipe }: ApplyParams): Promise<void> {
    const failed: ApplyStep[] = [];
    /** `expected` is the environment failure this step caught, left as a breadcrumb and a warning beside its count. */
    function fail(step: ApplyStep, expected?: { error: unknown; message: string }): void {
      failed.push(step);
      if (expected === undefined) {
        m.count(S.SETTINGS_APPLY, { outcome: 'error', reason: step });
        return;
      }
      reportExpected(expected.error, {
        flow: 'storage',
        step: 'settings_apply',
        metric: S.SETTINGS_APPLY,
        reason: step,
        message: expected.message,
      });
    }

    if (forceFullWipe) {
      if ((await wipeOrigin()).length > 0) {
        fail('wipe');
      }
      save(next);
      // Forces the cross-origin frames to purge regardless of their persisted prefs.
      try {
        schedulePendingReset(['protocol', 'sandbox']);
      } catch (error: unknown) {
        // No session storage, as in a private window, is the browser's limit rather than a fault.
        fail('pending_reset', { error, message: '[dot.li settings] purge request not stored:' });
      }
    } else {
      save(next);
      if (next.cache.skipCidCache && !prior.cache.skipCidCache && !(await clearCidCache())) {
        fail('cid_cache');
      }
      if (next.cache.skipArchiveCache && !prior.cache.skipArchiveCache && !(await clearBlockCache())) {
        fail('block_cache');
      }
    }

    // The URL carries the settings too, so the reload boots with them. Defaults drop off.
    const location = url.read();
    const search = new URLSearchParams(location.search);
    if (writeSettingsToSearch(next, search)) {
      const query = search.toString();
      url.replace(`${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    }
    if (failed.length === 0) {
      m.count(S.SETTINGS_APPLY, { outcome: 'ok' });
    }
  }

  async function applyAndReset(
    next: Settings,
    prior: Settings,
    { forceFullWipe = false, reason = 'settings_change' }: ApplyAndResetParams = {},
  ): Promise<void> {
    try {
      await apply({ next, prior, forceFullWipe });
    } catch (error: unknown) {
      // Beside the steps that count themselves. The error's class is in the capture.
      reportDefect(error, {
        flow: 'ui',
        step: 'settings_apply',
        metric: S.SETTINGS_APPLY,
        message: '[dot.li settings] Save & Apply failed:',
        reason: 'fault',
      });
    } finally {
      // The settings the user chose take effect only on the reload, so it runs whatever failed.
      reload(reason);
    }
  }

  return {
    /**
     * Applies `next` over `prior` and reloads. Deletes only caches the user just turned off. The persisted
     * `skipWorkerCache` flag makes the protocol iframe purge itself on its next boot. Settings persist before the
     * deletes so the reload boots with them. Never rejects: a step that fails is counted, and the rest of the reset and
     * the reload still run. The reload carries `reason`.
     */
    applyAndReset,
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
