// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Prod no-op shim for `@dotli/metrics/sentry`, aliased in
// `apps/*/vite.config.ts`. Types still come from `sentry.ts` at
// typecheck time. Aliases only apply at bundle time.

export type SentrySource = "host" | "worker" | "sandbox";

// Same literal as `sentry.ts`, so a full reset preserves the key on the off
// chance an earlier metrics-enabled build left one behind on this origin.
export const ANALYTICS_USER_KEY = "dotli:sentry-uuid";

export function initSentry(_source: SentrySource): void {
  /* no-op */
}

/** Always `null` here, which stops `reconcileAnalyticsUser` before any I/O. */
export function getAnalyticsUser(): string | null {
  return null;
}

export function adoptAnalyticsUser(_id: string): void {
  /* no-op */
}

export function installGlobalErrorHandlers(_source: SentrySource): void {
  /* no-op */
}

export function captureException(
  _err: unknown,
  _tags?: Record<string, string>,
): void {
  /* no-op */
}

export function isSmoldotEvent(_event: unknown): boolean {
  return false;
}
