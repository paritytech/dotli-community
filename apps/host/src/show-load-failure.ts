// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The failure screen's page effects: the reload, the backend switch and the sightings that escalate a repeated failure.

import { getSettings, writeSettingsToSearch, type Backend } from '@dotli/config';
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
 * Not consumed on read, and cleared on success, so a sighting means "this reload did not help". `session` is a getter,
 * since reading `sessionStorage` itself throws where storage is blocked.
 */
export function createSessionErrorSightings(
  session: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): ErrorSightings & { forget: () => void } {
  return {
    seen: kind => {
      try {
        return session().getItem(ERROR_SEEN_KEY) === kind;
      } catch {
        // Without sessionStorage every failure is a first sighting, which keeps the gentler screen.
        return false;
      }
    },
    remember: kind => {
      try {
        session().setItem(ERROR_SEEN_KEY, kind);
        // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode. Without it every failure stays a first sighting, which is the safe default.
      } catch {
        /* sessionStorage unavailable: the escalation simply never triggers */
      }
    },
    forget: () => {
      try {
        session().removeItem(ERROR_SEEN_KEY);
        // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, in which case nothing was ever written and there is nothing to clear.
      } catch {
        /* sessionStorage unavailable: nothing was stored, so nothing to clear */
      }
    },
  };
}

export const sessionErrorSightings = createSessionErrorSightings(() => sessionStorage);
