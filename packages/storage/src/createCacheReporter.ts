// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName, log } from '@dotli/shared';
import { captureException, m, recordExpected, spans as S } from '@dotli/metrics';
import { isExpectedDbError } from './isExpectedDbError.js';

type Params = {
  /** The cache's name, the surface of its metric and the start of its error steps. */
  cache: string;
  /** The prefix of the cache's log lines. */
  tag: string;
};

/**
 * Reports one cache's storage failures. Every failure is counted. An expected one leaves a breadcrumb. Any other is
 * logged and captured once per action for the reporter's life, since a stuck cache fails identically on every access.
 */
export function createCacheReporter({ cache, tag }: Params): (action: string, error: unknown) => void {
  const captured = new Set<string>();

  function report(action: string, error: unknown): void {
    const step = `${cache}_${action}`;
    m.count(S.CACHE_STORAGE, {
      outcome: 'error',
      reason: getErrorName(error) ?? 'unknown',
      surface: cache,
      step: action,
    });
    if (isExpectedDbError(error) || isQuotaError(error)) {
      recordExpected(error, { flow: 'storage', step });
      return;
    }
    log.error(`${tag} ${action} error:`, error);
    if (captured.has(action)) {
      return;
    }
    captured.add(action);
    captureException(error, { flow: 'storage', step, tags: { kind: `${step}_error` } });
  }

  return report;
}

/** Storage pressure makes a refused write routine, so it is not a fault of dotli. */
function isQuotaError(error: unknown): boolean {
  return getErrorName(error) === 'QuotaExceededError';
}
