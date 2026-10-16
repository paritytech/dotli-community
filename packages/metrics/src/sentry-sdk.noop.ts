// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// No-op twin of `@sentry/browser` for metrics-stripped builds. Mirrors only what code outside
// `sentry.ts` calls, since that module is swapped out too.

const noop = (): void => {
  /* no-op */
};

export const init = noop;
export const captureException = noop;
export const setUser = noop;
export const setTag = noop;
export const addBreadcrumb = noop;
export const setMeasurement = noop;

export function startSpan<T>(
  _opts: { op: string; name: string },
  fn: (span: { setAttribute: (key: string, value: string) => void } | undefined) => T,
): T {
  return fn(undefined);
}

export function browserTracingIntegration(_opts?: unknown): unknown {
  return undefined;
}

export const metrics = {
  count: noop,
  distribution: noop,
  gauge: noop,
} as const;
