// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The failure screen on this page: what its buttons do here.

import { getSettings, type Backend } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import { debugBus } from '@dotli/truapi-debug';
import { showErrorPage } from '@dotli/ui';
import { markAndReload } from './createContinuation.js';
import { getTrustedProviderHosts } from './describeError.js';
import { pageSettingsActions } from './createSettingsActions.js';
import { settingsIntent } from './createSettingsIntent.js';
import { sessionErrorSightings } from './createSessionErrorSightings.js';
import { presentLoadFailure, type LoadFailure } from './presentLoadFailure.js';
import { pendingResets } from './runtime/createPendingResets.js';

const report = createReporter({ flow: 'resolve' });

/**
 * A purge request the failure screen could not store before its reload. Tagged `outcome` and `reason`, as the reload
 * then comes up on the chain database it had.
 */
const pendingResetScheduleMetric = defineCount<'error'>('pending_reset.schedule');

/** This page's failure screen. */
export const loadFailureScreen = {
  /** Shows the screen for `failure`. Throws when the screen cannot be shown. */
  show(failure: LoadFailure): void {
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
  /** Records that the previous attempt's failure is behind the visitor. */
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
    report.expected(error, {
      step: 'pending_reset',
      metric: pendingResetScheduleMetric,
      reason: 'failure_screen',
      message: '[dot.li] protocol purge not stored before the reload:',
    });
  }
}
