// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportExpected } from '@dotli/metrics';
import { CoreRedialError } from '../pageCore.js';
import { reportWalletFailure } from '../walletFailure.js';
import { MainAccountError } from './createMainAccountSource.js';
import type { SiteRoundFailure } from './siteRoundErrors.js';

/** The `step` tag every report of a site's round carries. */
export const SITE_ROUND_STEP = 'site_round';

/**
 * Reports a failed step of a site's round and counts it as `error` with the step on `metric`. A failure caused by a
 * core redial, which is captured where the redial fails, or by a main session that is gone is counted, not captured.
 */
export function reportSiteFailure(failure: SiteRoundFailure, metric: string): void {
  if (isFromCoreRedial(failure) || isSignedOut(failure)) {
    reportExpected(failure, { flow: 'wallet', step: SITE_ROUND_STEP, metric, reason: failure.step });
    return;
  }
  reportWalletFailure(failure, {
    what: `site round ${failure.step}`,
    step: SITE_ROUND_STEP,
    reason: failure.step,
    metric,
  });
}

/** Whether `error` or an error in its chain of causes is a core redial. */
function isFromCoreRedial(error: unknown): boolean {
  let cause: unknown = error;
  while (cause instanceof Error) {
    if (cause instanceof CoreRedialError) {
      return true;
    }
    cause = cause.cause;
  }
  return false;
}

/** Whether `failure` is of a main session the core reports gone, which only a new sign-in brings back. */
function isSignedOut(failure: SiteRoundFailure): boolean {
  return failure.cause instanceof MainAccountError && failure.cause.kind === 'signed_out';
}
