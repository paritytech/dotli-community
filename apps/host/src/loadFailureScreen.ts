// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The failure screen on this page: what its buttons do here.

import { getSettings, type Backend } from '@dotli/config';
import { reportExpected, spans as S } from '@dotli/metrics';
import { debugBus } from '@dotli/truapi-debug';
import { showErrorPage } from '@dotli/ui';
import { markAndReload } from './createContinuation.js';
import { getTrustedProviderHosts } from './describeError.js';
import { pageSettingsActions } from './createSettingsActions.js';
import { settingsIntent } from './createSettingsIntent.js';
import { sessionErrorSightings } from './createSessionErrorSightings.js';
import { presentLoadFailure } from './presentLoadFailure.js';
import type { LoaderFailureScreen } from './createProductLoader.js';
import { pendingResets } from './runtime/createPendingResets.js';

/** This page's failure screen. */
export const loadFailureScreen: LoaderFailureScreen = {
  show(failure) {
    presentLoadFailure(failure, {
      showErrorPage,
      openSettings: settingsIntent.open,
      reload: reloadAfterFailure,
      switchBackend: switchBackendAndReload,
      resetProtocolOnReload,
      sightings: sessionErrorSightings,
      trustedProviderHosts: getTrustedProviderHosts,
      emit: debugBus.emit,
    });
  },
  forget: sessionErrorSightings.forget,
};

function reloadAfterFailure(): void {
  markAndReload('reload_button');
}

/** Saves the other backend as Save does, without clearing anything, and reloads onto it. */
function switchBackendAndReload(nextBackend: Backend): void {
  const settings = getSettings();
  void pageSettingsActions.applyAndReset({ ...settings, backend: nextBackend }, settings, { reason: 'switch_backend' });
}

function resetProtocolOnReload(): void {
  try {
    pendingResets.schedule(['protocol']);
  } catch (error: unknown) {
    // No session storage, as in a private window, so the reload comes up on the chain database it had.
    reportExpected(error, {
      flow: 'resolve',
      step: 'pending_reset',
      metric: S.PENDING_RESET_SCHEDULE,
      reason: 'failure_screen',
      message: '[dot.li] protocol purge not stored before the reload:',
    });
  }
}
