// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Prod no-op shim for `@dotli/metrics/sentry`, aliased in
// `apps/*/vite.config.ts`. Types still come from `sentry.ts` at
// typecheck time. Aliases only apply at bundle time.

export type SentrySource = "host" | "worker" | "sandbox";

export function initSentry(_source: SentrySource): void {
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
