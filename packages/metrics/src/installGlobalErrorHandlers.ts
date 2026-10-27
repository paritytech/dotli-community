// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as Sentry from '@sentry/browser';
import { log, StoreListenerError } from '@dotli/shared';

import { getNonErrorExtra } from './getNonErrorExtra.js';
import type { SentrySource } from './initSentry.js';
import { sentryCaptureSink } from './sentryCaptureSink.js';
import { toNonErrorThrow } from './toNonErrorThrow.js';

// Read in this module, not shared, so the metrics-off build drops the SDK.
const METRICS_ENABLED = import.meta.env.VITE_METRICS === 'true';

/**
 * Route uncaught errors and rejections to Sentry.
 * An `Error` passes unwrapped to keep its stack, and an `ErrorEvent` keeps its location even when
 * `event.error` is null (resource-load failures, CORS-tainted scripts).
 */
export function installGlobalErrorHandlers(source: SentrySource): void {
  if (!METRICS_ENABLED || typeof self === 'undefined') {
    return;
  }

  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    log.error(`[dot.li ${source}] unhandled rejection:`, reason);
    const error = reason instanceof Error ? reason : toNonErrorThrow(reason);
    Sentry.captureException(error, {
      mechanism: { type: 'onunhandledrejection', handled: false },
      captureContext: {
        tags: { kind: 'unhandledrejection', source },
        ...(reason instanceof Error ? {} : { extra: getNonErrorExtra(reason) }),
      },
    });
  });

  self.addEventListener('error', (event: ErrorEvent) => {
    if (event.error instanceof StoreListenerError) {
      log.error(`[dot.li ${source}] store listener failed:`, event.error);
      // The listener's own error keeps the issue title and grouping of its real type, and the log line names the store.
      sentryCaptureSink.exception(event.error.cause instanceof Error ? event.error.cause : event.error, {
        flow: 'ui',
        step: 'store_listener',
        tags: { store: event.error.store, kind: 'store_listener_error', source },
      });
      return;
    }
    log.error(`[dot.li ${source}] window error:`, event.error ?? event.message);
    const extra: Record<string, unknown> = {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      message: event.message,
    };
    const error =
      event.error instanceof Error ? event.error : new Error(event.message || 'window error (no Error object)');
    Sentry.captureException(error, {
      mechanism: { type: 'onerror', handled: false },
      captureContext: {
        tags: { kind: 'window_error', source },
        extra: event.error instanceof Error ? extra : { ...extra, rawError: event.error },
      },
    });
  });
}
