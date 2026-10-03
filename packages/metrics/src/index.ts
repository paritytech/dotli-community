// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/metrics. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export { getResolutionId, m, setResolutionId, type SpanHandle, type SpanValue } from './metrics.js';
export {
  captureException,
  initSentry,
  installGlobalErrorHandlers,
  recordExpected,
  type CaptureContext,
  type Flow,
  type SentrySource,
} from './sentry.js';
export * as spans from './spans.js';
