// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as Sentry from '@sentry/browser';

import type { Reporter } from './createReporter.js';
import { defineCount } from './defineCount.js';
import { spans as S } from './spans.js';

// Read in this module, not shared, so the metrics-off build drops the SDK.
const METRICS_ENABLED = import.meta.env.VITE_METRICS === 'true';

/**
 * One flush of buffered telemetry before a context closes. Counted only when the flush threw, tagged `outcome` and
 * `reason` (the error's name).
 */
const telemetryFlushMetric = defineCount<'error'>(S.TELEMETRY_FLUSH);

/**
 * Sends what Sentry has buffered, waiting at most `timeoutMs`. Resolves at once when metrics are off, and never
 * rejects, since its callers are on their way out. A failure is reported best effort through the caller's reporter.
 */
export async function flushTelemetry(timeoutMs: number, report: Reporter): Promise<void> {
  if (!METRICS_ENABLED) {
    return;
  }
  try {
    await Sentry.flush(timeoutMs);
  } catch (error: unknown) {
    report.defect(error, {
      step: 'flush_telemetry',
      metric: telemetryFlushMetric,
      message: '[dot.li sentry] flush failed',
    });
  }
}
