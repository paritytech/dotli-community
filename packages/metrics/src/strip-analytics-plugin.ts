// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time plugin for the app vite configs. When `strip` is true (i.e.
// VITE_METRICS is not "true") it swaps the Sentry and metrics modules for their
// no-op twins. The swap keys on the resolved file, not on the import
// specifier, so it catches the `@dotli/metrics` barrel's re-exports and
// relative imports inside the package alike. Worker bundles don't inherit the
// app's `plugins`, so each config also lists it under `worker.plugins`. Self-resolves paths via
// `import.meta.url` (web `URL` only, no Node APIs, so this typechecks under
// the metrics package's browser-target tsconfig).

import type { Plugin } from 'vite';

const METRICS_SRC = new URL('.', import.meta.url).pathname;

const SENTRY_SDK_NOOP = `${METRICS_SRC}sentry-sdk.noop.ts`;
const NOOP_BY_FILE = new Map([
  [`${METRICS_SRC}sentry.ts`, `${METRICS_SRC}sentry.noop.ts`],
  [`${METRICS_SRC}metrics.ts`, `${METRICS_SRC}metrics.noop.ts`],
]);

export function stripAnalytics(strip: boolean): Plugin | false {
  if (!strip) {
    return false;
  }
  return {
    name: 'dotli-strip-analytics',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source === '@sentry/browser') {
        return SENTRY_SDK_NOOP;
      }
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      const noop = resolved ? NOOP_BY_FILE.get(resolved.id) : undefined;
      return noop ?? resolved;
    },
  };
}
