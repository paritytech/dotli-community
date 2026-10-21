// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { errorName, log } from '@dotli/shared';
import { captureException, m, recordExpected, spans as S } from '@dotli/metrics';
import { isExpectedDbError } from './db.js';

/** Storage pressure makes a refused write routine, so it is not a fault of dotli. */
function isQuotaError(err: unknown): boolean {
  return errorName(err) === 'QuotaExceededError';
}

/**
 * Reports one cache's storage failures. Every failure is counted. An expected one leaves a breadcrumb. Any other is
 * logged and captured once per action for the reporter's life, since a stuck cache fails identically on every access.
 */
export function createCacheReporter(cache: string, tag: string): (action: string, err: unknown) => void {
  const captured = new Set<string>();
  return (action, err) => {
    const step = `${cache}_${action}`;
    m.count(S.CACHE_STORAGE, { outcome: 'error', reason: errorName(err) ?? 'unknown', surface: cache, step: action });
    if (isExpectedDbError(err) || isQuotaError(err)) {
      recordExpected(err, { flow: 'storage', step });
      return;
    }
    log.error(`${tag} ${action} error:`, err);
    if (captured.has(action)) {
      return;
    }
    captured.add(action);
    captureException(err, { flow: 'storage', step, tags: { kind: `${step}_error` } });
  };
}
