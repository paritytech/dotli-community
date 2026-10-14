// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings this page runs with, read at boot. A link that changes a saved choice wipes and reloads, as Save does.

import {
  hasStoredSettings,
  parseSettingsFromSearch,
  resolveSettings,
  setSettings,
  sharedSettingsOf,
  writeLocalSettings,
  writeSettingsToSearch,
  type Settings,
  type SharedSettings,
} from '@dotli/config';
import type { SafeStorage } from '@dotli/shared';
import type { ShowNotification } from '@dotli/ui';
import type { ModeDraft, SettingsActions } from './settings-actions.js';

export interface SettingsBootDeps {
  /** The page's query string. */
  search: string;
  /** This origin's storage, which never throws. */
  local: SafeStorage;
  sharedWorkerAvailable: boolean;
  /** On localhost, where each origin is its own site and parallel test workers must stay apart. */
  preferLocal: boolean;
  /** The cross-subdomain store's settings, or null when it cannot be read, which it reports itself. */
  readShared: () => Promise<SharedSettings | null>;
  /** Mirrors the settings to the cross-subdomain store, reporting its own failures. */
  writeShared: (shared: SharedSettings) => void;
  /** Configures the protocol frame, through which the shared store is read. */
  configureFrame: (settings: Settings) => void;
  /** Wipes and reloads when the link displaces a saved choice, as Save does. */
  actions: Pick<SettingsActions, 'applyAndReset'>;
  notify: ShowNotification;
  /** Replaces the page's query string without a navigation. */
  replaceSearch: (query: string) => void;
}

/** The settings as the settings popover edits them. */
function draftOf(settings: Settings): ModeDraft {
  return { chain: settings.backend, network: settings.network, cache: settings.cache };
}

/**
 * Sets this page's settings and resolves them. The part before the first await sets this origin's settings and the
 * link's, for the readers that start before the shared store answers, and boots the frame on them.
 */
export async function bootSettings(deps: SettingsBootDeps): Promise<Settings> {
  const search = new URLSearchParams(deps.search);
  const url = parseSettingsFromSearch(search);
  // Before anything is stored, since every visit stores its settings and would look returning after.
  const returning = hasStoredSettings(deps.local);
  const sources = {
    local: deps.local,
    sharedWorkerAvailable: deps.sharedWorkerAvailable,
    preferLocal: deps.preferLocal,
  };

  const own = resolveSettings({ ...sources, shared: null, url });
  setSettings(own);
  deps.configureFrame(own);

  const shared = await deps.readShared();
  const prior = resolveSettings({ ...sources, shared });
  const next = resolveSettings({ ...sources, shared, url });
  // The choice before this browser's limit applies, so only a shared light client it cannot run is announced.
  const wanted = resolveSettings({
    ...sources,
    sharedWorkerAvailable: true,
    shared,
    url,
  });
  setSettings(next);
  writeLocalSettings(next, deps.local);
  if (shared !== null) {
    deps.writeShared(sharedSettingsOf(next));
  }

  if (writeSettingsToSearch({ network: next.network, chainBackend: next.backend, cache: next.cache }, search)) {
    deps.replaceSearch(search.toString());
  }

  if (wanted.backend === 'smoldot-shared-worker' && next.backend !== wanted.backend) {
    deps.notify({
      label: 'Light client shared unavailable',
      text: "This browser doesn't support Light client shared. Falling back to Light client per tab.",
      tone: 'warn',
      dismissMs: 5_000,
    });
  }

  // A fresh origin has nothing stale, and a link that matches the saved settings changes nothing. The other two
  // origins purge themselves on their next boot.
  if (returning && !sameSettings(next, prior)) {
    await deps.actions.applyAndReset(draftOf(next), draftOf(prior), { forceFullWipe: true });
  }
  return next;
}

function sameSettings(a: Settings, b: Settings): boolean {
  return (
    a.network === b.network &&
    a.backend === b.backend &&
    a.cache.skipArchiveCache === b.cache.skipArchiveCache &&
    a.cache.skipCidCache === b.cache.skipCidCache &&
    a.cache.skipWorkerCache === b.cache.skipWorkerCache
  );
}
