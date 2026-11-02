// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type { CaptureContext, CaptureSink, Flow } from './captureException.js';
export { bindCaptureSink, captureException } from './captureException.js';
export type { SpanHandle } from './createSpanHandle.js';
export { flushTelemetry } from './flushTelemetry.js';
export { initSentry } from './initSentry.js';
export { installGlobalErrorHandlers } from './installGlobalErrorHandlers.js';
export { m } from './metrics.js';
export { reportDefect } from './reportDefect.js';
export { reportExpected } from './reportExpected.js';
export { reportListener } from './reportListener.js';
export { getResolutionId, setResolutionId } from './resolutionId.js';
export { spans } from './spans.js';
export type { MetricOutcome, SpanValue } from './types.js';
