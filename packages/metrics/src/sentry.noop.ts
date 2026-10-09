// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// No-op twin of `sentry.ts`, swapped in by `stripAnalytics`. Typecheck only ever sees the real module.

export type SentrySource = 'host' | 'protocol' | 'worker' | 'sandbox';

export function initSentry(_source: SentrySource): void {
  /* no-op */
}

export function installGlobalErrorHandlers(_source: SentrySource): void {
  /* no-op */
}

export function captureException(_err: unknown, _ctx: unknown): void {
  /* no-op */
}

export function recordExpected(_err: unknown, _ctx: unknown): void {
  /* no-op */
}

export function isSmoldotEvent(_event: unknown): boolean {
  return false;
}

export function excludeBrowserApiErrorsIntegration<T extends { name: string }>(integrations: T[]): T[] {
  return integrations;
}
