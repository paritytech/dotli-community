// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings this page runs with, read at boot. A link that changes a saved choice wipes and reloads, as Save does.

import {
  hasStoredSettings,
  parseSettingsFromSearch,
  resolveSettings,
  setSettings,
  getSharedSettings,
  writeLocalSettings,
  writeSettingsToSearch,
  type Settings,
  type SharedSettings,
} from '@dotli/config';
import type { SafeStorage } from '@dotli/shared';
import type { ShowNotification } from '@dotli/ui';
import type { SettingsActions } from './createSettingsActions.js';

export type BootSettingsParams = {
  /** The page's query string. */
  search: string;
  /** This origin's storage, which never throws. */
  local: SafeStorage;
  sharedWorkerAvailable: boolean;
  /**
   * Whether this origin's choice wins: on localhost, whose shared store is the local server's, so parallel test
   * workers must stay apart.
   */
  preferLocal: boolean;
  /** The cross-subdomain store's settings, or null when it cannot be read, which it reports itself. */
  readShared: () => Promise<SharedSettings | null>;
  /** Mirrors the settings to the cross-subdomain store, reporting its own failures. */
  writeShared: (shared: SharedSettings) => void;
  /**
   * Configures the protocol frame, through which the shared store is read, on the settings set so far. Called again
   * once the shared store answers, unless a reset reloads the page.
   */
  configureFrame: (settings: Settings) => void;
  /** Wipes and reloads when the link displaces a saved choice, as Save does. */
  actions: Pick<SettingsActions, 'applyAndReset'>;
  notify: ShowNotification;
  /** Replaces the page's query string without a navigation. */
  replaceSearch: (query: string) => void;
};

/**
 * Sets this page's settings and resolves them. The part before the first await sets this origin's settings and the
 * link's, for the readers that start before the shared store answers, and boots the frame on them. Rejects only as one
 * of `params` does.
 */
export async function readBootSettings(params: BootSettingsParams): Promise<Settings> {
  const search = new URLSearchParams(params.search);
  const url = parseSettingsFromSearch(search);
  // Before anything is stored, since every visit stores its settings and would look returning after.
  const returning = hasStoredSettings(params.local);
  const sources = {
    local: params.local,
    sharedWorkerAvailable: params.sharedWorkerAvailable,
    preferLocal: params.preferLocal,
  };

  const own = resolveSettings({ ...sources, shared: null, url }).settings;
  setSettings(own);
  params.configureFrame(own);

  const shared = await params.readShared();
  const prior = resolveSettings({ ...sources, shared }).settings;
  const { settings: next, sharedWorkerFallback } = resolveSettings({ ...sources, shared, url });
  setSettings(next);
  writeLocalSettings(next, params.local);
  // A fresh origin has nothing stale, and a link that matches the saved settings changes nothing. The other two
  // origins purge themselves on their next boot. The frame keeps its config through the reset, since a rebuild would
  // hold the shared store writes until it listens and the reload could drop them.
  const reset = returning && !isSameSettings(next, prior);
  // Before the write, so it waits for the rebuilt frame. A write begun first fails when the frame is rebuilt under it.
  if (!reset) {
    params.configureFrame(next);
  }
  if (shared !== null) {
    params.writeShared(getSharedSettings(next));
  }

  if (writeSettingsToSearch(next, search)) {
    params.replaceSearch(search.toString());
  }

  if (sharedWorkerFallback) {
    params.notify({
      label: 'Light client shared unavailable',
      text: "This browser doesn't support Light client shared. Falling back to Light client per tab.",
      tone: 'warn',
      dismissMs: 5_000,
    });
  }

  if (reset) {
    await params.actions.applyAndReset(next, prior, { forceFullWipe: true });
  }
  return next;
}

function isSameSettings(left: Settings, right: Settings): boolean {
  return (
    left.network === right.network &&
    left.backend === right.backend &&
    left.cache.skipArchiveCache === right.cache.skipArchiveCache &&
    left.cache.skipCidCache === right.cache.skipCidCache &&
    left.cache.skipWorkerCache === right.cache.skipWorkerCache
  );
}
