// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The failure screen's page effects: the reload, the backend switch and the sightings that escalate a repeated failure.

import { getSettings, writeSettingsToSearch, type Backend } from '@dotli/config';
import { pageSessionStorage, type SafeStorage } from '@dotli/shared';
import { markContinuation } from './continuation.js';
import { saveSettings } from './settings-actions.js';
import type { ErrorSightings } from './load-failure.js';

export function reloadAfterFailure(): void {
  markContinuation('reload_button');
  window.location.reload();
}

export function switchBackendAndReload(nextBackend: Backend): void {
  const settings = { ...getSettings(), backend: nextBackend };
  saveSettings(settings);
  const search = new URLSearchParams(window.location.search);
  if (writeSettingsToSearch({ network: settings.network, chainBackend: nextBackend, cache: settings.cache }, search)) {
    const query = search.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', newUrl);
  }
  markContinuation('switch_backend');
  window.location.reload();
}

const ERROR_SEEN_KEY = 'dotli:error-seen';

/**
 * Not consumed on read, and cleared on success, so a sighting means "this reload did not help". Without storage every
 * failure is a first sighting, which keeps the gentler screen.
 */
export function createSessionErrorSightings(
  session: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>,
): ErrorSightings & { forget: () => void } {
  return {
    seen: kind => {
      return session.getItem(ERROR_SEEN_KEY) === kind;
    },
    remember: kind => {
      session.setItem(ERROR_SEEN_KEY, kind);
    },
    forget: () => {
      session.removeItem(ERROR_SEEN_KEY);
    },
  };
}

export const sessionErrorSightings = createSessionErrorSightings(pageSessionStorage);
