// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metrics } from './createLiveMetrics.js';
import { INERT_SPAN_HANDLE } from './createSpanHandle.js';

/** The metrics API of a build without metrics: the live API's shape, recording nothing even with a Sentry bound. */
export function createInertMetrics(): Metrics {
  return {
    enabled: false,
    bind: () => doNothing,
    span: runWithoutSpan,
    open: () => INERT_SPAN_HANDLE,
    measure: doNothing,
    count: doNothing,
    distribution: doNothing,
    gauge: doNothing,
    tag: doNothing,
    setDefaults: doNothing,
    clearDefaults: doNothing,
    breadcrumb: doNothing,
    timer: () => stopAtZero,
  };
}

function runWithoutSpan<Result>(_name: string, fn: (span: undefined) => Result): Result {
  return fn(undefined);
}

function doNothing(): void {
  /* nothing to record */
}

function stopAtZero(): number {
  return 0;
}
