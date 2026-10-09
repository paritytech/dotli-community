// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Swaps the Sentry and metrics modules for no-op twins. Keys on the resolved file to catch barrel
// re-exports and relative imports alike. Workers don't inherit `plugins`, so list it under `worker.plugins` too.

import type { Plugin } from 'vite';

// Web `URL` rather than Node APIs, to typecheck under the browser tsconfig.
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
