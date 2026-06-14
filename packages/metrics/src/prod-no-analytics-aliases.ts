// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time helper for app vite configs. Maps the Sentry and metrics
// modules to no-op shims when `stripAnalytics` is true (i.e. VITE_METRICS is
// not "true"). Self-resolves noop paths via `import.meta.url` (web `URL` only,
// no Node APIs, so this typechecks under the metrics package's browser-target
// tsconfig).

const METRICS_SRC = new URL(".", import.meta.url).pathname;

export function prodNoAnalyticsAliases(
  stripAnalytics: boolean,
): Record<string, string> {
  if (!stripAnalytics) {
    return {};
  }
  return {
    "@dotli/metrics/sentry": `${METRICS_SRC}sentry.noop`,
    "@dotli/metrics/metrics": `${METRICS_SRC}metrics.noop`,
    "@sentry/browser": `${METRICS_SRC}sentry-sdk.noop`,
  };
}
