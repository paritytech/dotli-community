// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  bindCaptureSink,
  captureException,
  recordExpected,
  reportExpected,
  reportListener,
  type CaptureContext,
  type CaptureSink,
  type ExpectedReport,
  type Flow,
} from './capture.js';
export { getResolutionId, m, setResolutionId, type MetricOutcome, type SpanHandle, type SpanValue } from './metrics.js';
export { flushTelemetry, initSentry, installGlobalErrorHandlers } from './sentry.js';
export * as spans from './spans.js';
