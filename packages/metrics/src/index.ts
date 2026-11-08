// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type { CaptureContext, CaptureSink } from './captureException.js';
export { bindCaptureSink } from './captureException.js';
export type { DefectParams, ExpectedParams, Reporter } from './createReporter.js';
export { createReporter } from './createReporter.js';
export type { SpanHandle } from './createSpanHandle.js';
export type { CountAttributes, CountMetric, CountSink } from './defineCount.js';
export { countMetric, defineCount } from './defineCount.js';
export { flushTelemetry } from './flushTelemetry.js';
export { initSentry } from './initSentry.js';
export { installGlobalErrorHandlers } from './installGlobalErrorHandlers.js';
export { m } from './metrics.js';
export { getResolutionId, setResolutionId } from './resolutionId.js';
export { spans } from './spans.js';
export type { SpanValue } from './types.js';
