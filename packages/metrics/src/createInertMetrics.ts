// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metrics } from './createLiveMetrics.js';
import { INERT_SPAN_HANDLE } from './createSpanHandle.js';
import type { MeasureParams, MetricParams, TimerParams } from './types.js';

/** The metrics API of a build without metrics: the live API's shape, recording nothing even with a Sentry bound. */
export function createInertMetrics(): Metrics {
  return {
    enabled: false,
    bind: () => doNothing,
    span: runWithoutSpan,
    open: () => INERT_SPAN_HANDLE,
    measure: skipMeasurement,
    count: doNothing,
    distribution: skipSample,
    gauge: skipSample,
    tag: doNothing,
    setDefaults: doNothing,
    clearDefaults: doNothing,
    breadcrumb: doNothing,
    timer: startZeroTimer,
  };
}

function runWithoutSpan<Result>(_name: string, fn: (span: undefined) => Result): Result {
  return fn(undefined);
}

function skipMeasurement(_name: string, _value: number, _params: MeasureParams = {}): void {
  /* nothing to record */
}

function skipSample(_name: string, _value: number, _params: MetricParams = {}): void {
  /* nothing to record */
}

function startZeroTimer(_name: string, _params: TimerParams = {}): () => number {
  return stopAtZero;
}

function doNothing(): void {
  /* nothing to record */
}

function stopAtZero(): number {
  return 0;
}
