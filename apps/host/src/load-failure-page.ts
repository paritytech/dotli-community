// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The failure screen on this page: what its buttons do here, and the sightings that let a failure a reload did not fix
// offer more.

import { getSettings, type Backend } from '@dotli/config';
import { reportExpected, spans as S } from '@dotli/metrics';
import { pageSessionStorage, type SafeStorage } from '@dotli/shared';
import { emitDotliDebugEvent } from '@dotli/truapi-debug';
import { showErrorPage } from '@dotli/ui';
import { markContinuation } from './continuation.js';
import { trustedProviderHosts } from './errors.js';
import { presentLoadFailure, type ErrorSightings } from './load-failure.js';
import type { LoaderFailureScreen } from './product-loader.js';
import { schedulePendingReset } from './runtime/pending-reset.js';
import { pageSettingsActions } from './settings-actions.js';
import { openSettings } from './settings-intent.js';

function reloadAfterFailure(): void {
  markContinuation('reload_button');
  window.location.reload();
}

/** Saves the other backend as Save does, without clearing anything, and reloads onto it. */
function switchBackendAndReload(nextBackend: Backend): void {
  const settings = getSettings();
  void pageSettingsActions.applyAndReset({ ...settings, backend: nextBackend }, settings, { reason: 'switch_backend' });
}

function resetProtocolOnReload(): void {
  try {
    schedulePendingReset(['protocol']);
  } catch (err: unknown) {
    // No session storage, as in a private window, so the reload comes up on the chain database it had.
    reportExpected(err, {
      flow: 'resolve',
      step: 'pending_reset',
      metric: S.PENDING_RESET_SCHEDULE,
      reason: 'failure_screen',
      message: '[dot.li] protocol purge not stored before the reload:',
    });
  }
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

const sessionErrorSightings = createSessionErrorSightings(pageSessionStorage);

/** This page's failure screen. */
export const loadFailureScreen: LoaderFailureScreen = {
  show: failure => {
    presentLoadFailure(failure, {
      showErrorPage,
      openSettings,
      reload: reloadAfterFailure,
      switchBackend: switchBackendAndReload,
      resetProtocolOnReload,
      sightings: sessionErrorSightings,
      trustedProviderHosts,
      emit: emitDotliDebugEvent,
    });
  },
  forget: sessionErrorSightings.forget,
};
