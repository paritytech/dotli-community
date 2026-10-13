// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fetches the failure screens only when a load fails, and still says why it failed when they cannot be fetched.
// The effects, copy and icons the screens use come from here, because the lazy chunk would split the modules it shares
// with the landing page into extra boot files, and a successful load clears the sighting.

import { captureException, m, spans as S } from '@dotli/metrics';
import { getCacheSettings, getNetwork, setBackend, writeSettingsToSearch, type Backend } from '@dotli/config';
import { log } from '@dotli/shared';
import { markContinuation } from './continuation.js';
import { RotateCwIcon } from '@dotli/ui/icons';
import {
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  trustedProviderHosts,
  TRY_ANYWAY_BTN_LABEL,
} from './errors.js';
import type { LoadFailureModule } from './lazy.js';
import type { ErrorSightings, FailureScreenCopy, LoadFailure, LoadFailureDeps } from './load-failure.js';

const COPY: FailureScreenCopy = {
  reload: RELOAD_BTN_LABEL,
  reloadIcon: RotateCwIcon,
  openSettings: OPEN_SETTINGS_BTN_LABEL,
  tryAnyway: TRY_ANYWAY_BTN_LABEL,
  goBack: GO_BACK_BTN_LABEL,
  failover: FAILOVER_BTN_LABELS,
};

export interface ShowLoadFailureDeps extends Omit<LoadFailureDeps, 'copy' | 'trustedProviderHosts'> {
  load: () => Promise<LoadFailureModule>;
}

/** Shows the failure's recovery screen, or its title, message and tips alone when the screen code is unreachable. */
export async function showLoadFailure(failure: LoadFailure, deps: ShowLoadFailureDeps): Promise<void> {
  const { load, ...effects } = deps;
  const { error } = failure;
  // Logged before the fetch, so a fallback page leaves the same breadcrumb as a full screen.
  log.event('Error page shown', { flow: 'resolve', error_kind: error.kind, recovery: error.recovery });
  let screens: LoadFailureModule;
  try {
    screens = await load();
  } catch (err) {
    // The one report of this failure. The boot's preload listener only leaves a breadcrumb for a chunk miss.
    log.error('[dot.li] failure screens failed to load:', err);
    captureException(err, { flow: 'resolve', step: 'failure_screen_load', tags: { error_kind: failure.error.kind } });
    m.count(S.FAILURE_SCREEN_LOAD, { outcome: 'error', reason: 'chunk_load' });
    await effects.showErrorPage({ title: error.title, detail: error.message, tips: error.tips });
    return;
  }
  m.count(S.FAILURE_SCREEN_LOAD, { outcome: 'ok' });
  screens.presentLoadFailure(failure, { ...effects, copy: COPY, trustedProviderHosts });
}

export function reloadAfterFailure(): void {
  markContinuation('reload_button');
  window.location.reload();
}

export function switchBackendAndReload(nextBackend: Backend): void {
  setBackend(nextBackend);
  const search = new URLSearchParams(window.location.search);
  if (writeSettingsToSearch({ network: getNetwork(), chainBackend: nextBackend, cache: getCacheSettings() }, search)) {
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
