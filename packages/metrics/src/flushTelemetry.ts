// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as Sentry from '@sentry/browser';

import { reportDefect } from './reportDefect.js';
import { spans as S } from './spans.js';

// Read in this module, not shared, so the metrics-off build drops the SDK.
const METRICS_ENABLED = import.meta.env.VITE_METRICS === 'true';

/**
 * Sends what Sentry has buffered, waiting at most `timeoutMs`. Resolves at once when metrics are off, and never
 * rejects, since its callers are on their way out. A failure is reported best effort.
 */
export async function flushTelemetry(timeoutMs: number): Promise<void> {
  if (!METRICS_ENABLED) {
    return;
  }
  try {
    await Sentry.flush(timeoutMs);
  } catch (error: unknown) {
    reportDefect(error, {
      flow: 'protocol',
      step: 'flush_telemetry',
      metric: S.TELEMETRY_FLUSH,
      message: '[dot.li sentry] flush failed',
    });
  }
}
