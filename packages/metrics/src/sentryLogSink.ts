// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as Sentry from '@sentry/browser';
import { serializeError, type LogEntry, type LogLevel } from '@dotli/shared';

/** A log sink that turns each log line into a Sentry breadcrumb, so handled failures leave a trail in production. */
export const sentryLogSink = {
  /** Adds the line as a breadcrumb under its `flow` attribute, or `log`, with the first `Error` argument serialized. */
  emit: addBreadcrumbForLine,
};

function addBreadcrumbForLine({ level, message, attrs: attributes, args }: LogEntry): void {
  const { flow, ...data } = attributes ?? {};
  if (args !== undefined && args.length > 0) {
    const errorArgument = args.find(argument => argument instanceof Error);
    if (errorArgument !== undefined) {
      data['error'] = serializeError(errorArgument);
    }
  }
  Sentry.addBreadcrumb({
    category: typeof flow === 'string' ? flow : 'log',
    level: getBreadcrumbLevel(level),
    message,
    data,
  });
}

function getBreadcrumbLevel(level: LogLevel): 'info' | 'warning' | 'error' {
  switch (level) {
    case 'debug':
    case 'info':
      return 'info';
    case 'warn':
      return 'warning';
    case 'error':
      return 'error';
  }
}
