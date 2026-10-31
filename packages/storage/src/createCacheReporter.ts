// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName, log } from '@dotli/shared';
import { m, reportDefect, reportExpected, spans as S } from '@dotli/metrics';
import { isExpectedDbError } from './isExpectedDbError.js';

type Params = {
  /** The cache's name, the surface of its metric and the start of its error steps. */
  cache: string;
  /** The prefix of the cache's log lines. */
  tag: string;
};

/**
 * Reports one cache's storage failures. Every failure is counted. An expected one leaves a breadcrumb and no issue. Any
 * other is logged and captured once per action for the reporter's life, since a stuck cache fails identically on every
 * access.
 */
export function createCacheReporter({ cache, tag }: Params): (action: string, error: unknown) => void {
  const captured = new Set<string>();

  function report(action: string, error: unknown): void {
    const step = `${cache}_${action}`;
    const attributes = { surface: cache, step: action };
    if (isExpectedDbError(error) || isQuotaError(error)) {
      reportExpected(error, { flow: 'storage', step, metric: S.CACHE_STORAGE, attributes });
      return;
    }
    const message = `${tag} ${action} error:`;
    if (captured.has(action)) {
      log.error(message, error);
      m.count(S.CACHE_STORAGE, { ...attributes, outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
      return;
    }
    captured.add(action);
    reportDefect(error, {
      flow: 'storage',
      step,
      tags: { kind: `${step}_error` },
      metric: S.CACHE_STORAGE,
      attributes,
      message,
    });
  }

  return report;
}

/** Storage pressure makes a refused write routine, so it is not a fault of dotli. */
function isQuotaError(error: unknown): boolean {
  return getErrorName(error) === 'QuotaExceededError';
}
