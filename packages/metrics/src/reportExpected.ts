// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName, log } from '@dotli/shared';

import { recordExpected, type CaptureContext } from './captureException.js';
import { m } from './metrics.js';
import type { MetricOutcome } from './types.js';

type Params = {
  /** The outcome metric the failure is counted under. */
  metric: string;
  /** Defaults to the error's class name, or `unknown` for a thrown non-error. */
  reason?: string;
  /** Defaults to `error`. */
  outcome?: MetricOutcome;
  /** Logged as a warning with the error. Leave it out when the failure needs no line in the log. */
  message?: string;
} & Pick<CaptureContext, 'flow' | 'step'>;

/** Report an environment failure: an optional warning, its breadcrumb and one count of its outcome metric. */
export function reportExpected(
  error: unknown,
  { flow, step, metric, reason, outcome = 'error', message }: Params,
): void {
  if (message !== undefined) {
    log.warn(message, error);
  }
  recordExpected(error, { flow, step });
  m.count(metric, { outcome, reason: reason ?? getErrorName(error) ?? 'unknown' });
}
