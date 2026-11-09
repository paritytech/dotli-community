// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settings persistence and the reset that applies them. Imports no Solid and loads eagerly because the host's boot
// resets through it when a URL changes the settings, before any island has loaded.

import { createReporter, defineCount } from '@dotli/metrics';
import { createDeferred, pageLocalStorage } from '@dotli/shared';
import { atom, computed } from 'nanostores';
import { markAndReload, type Continuation } from './createContinuation.js';
import { getSharedSettings, writeLocalSettings, writeSettingsToSearch, type Settings } from '@dotli/config';
import { blockCache, cidCache } from '@dotli/storage';

import type { SettingsResetStatus } from './components/settings/settings.js';
import { pendingResets, type PendingResetTarget } from './runtime/createPendingResets.js';
import { writeSharedSettings } from './runtime/sharedMode.js';
import { wipeOriginState, type WipeFailure } from './wipeOriginState.js';

const storageReport = createReporter({ flow: 'storage' });
const uiReport = createReporter({ flow: 'ui' });

/**
 * One settings reset: Save & Apply or Clear all in the settings, a link that changes a saved choice, or the failure
 * screen's backend switch. Tagged `outcome` and, on error, `reason` (the step that failed: `wipe`, `cid_cache`,
 * `block_cache` or `pending_reset`, or the error's name for a step that threw), as the reload follows either way.
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

/** `running` never returns to `idle`, since the reload follows it. */
type Reset = { kind: 'idle' } | { kind: 'running'; fullWipe: boolean; done: Promise<void> };

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
  const resetState = atom<Reset>({ kind: 'idle' });
  const reset = computed(resetState, (state): SettingsResetStatus => {
    if (state.kind === 'idle') {
      return 'idle';
    }
    return state.fullWipe ? 'clearing' : 'applying';
  });

  async function apply({ next, prior, forceFullWipe }: ApplyParams): Promise<void> {
    const failed: ApplyStep[] = [];
    /** `expected` is the environment failure this step caught, left as a breadcrumb and a warning beside its count. */
    function fail(step: ApplyStep, expected?: { error: unknown; message: string }): void {
      failed.push(step);
      if (expected === undefined) {
        settingsApplyMetric.count({ outcome: 'error', reason: step });
        return;
      }
      storageReport.expected(expected.error, {
        step: 'settings_apply',
        metric: settingsApplyMetric,
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
      settingsApplyMetric.count({ outcome: 'ok' });
    }
  }

  function applyAndReset(
    next: Settings,
    prior: Settings,
    { forceFullWipe = false, reason = 'settings_change' }: ApplyAndResetParams = {},
  ): Promise<void> {
    const state = resetState.get();
    if (state.kind === 'running') {
      return state.done;
    }
    const finished = createDeferred<undefined>();
    resetState.set({ kind: 'running', fullWipe: forceFullWipe, done: finished.promise });
    void runReset({ next, prior, forceFullWipe }, reason).then(
      () => {
        finished.resolve(undefined);
      },
      (error: unknown) => {
        finished.reject(error);
      },
    );
    return finished.promise;
  }

  async function runReset(params: ApplyParams, reason: Continuation): Promise<void> {
    try {
      await apply(params);
    } catch (error: unknown) {
      // Beside the steps that count themselves. The error's class is in the capture.
      uiReport.defect(error, {
        step: 'settings_apply',
        metric: settingsApplyMetric,
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
     * deletes so the reload boots with them. Rejects only as `reload` throws: a step that fails is counted, and the rest of
     * the reset and the reload still run. The reload carries `reason`. A call while a reset runs saves and reloads nothing and
     * resolves when the running one does.
     */
    applyAndReset,
    /**
     * The running reset, `idle` until one starts. It never returns to `idle`, since the reload follows. Never throws.
     */
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
