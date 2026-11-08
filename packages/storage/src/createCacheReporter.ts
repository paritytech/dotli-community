// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName } from '@dotli/shared';
import { createReporter, defineCount } from '@dotli/metrics';
import { isExpectedDbError } from './isExpectedDbError.js';

const storageReport = createReporter({ flow: 'storage' });

/**
 * A cache's storage step that failed. Counted only on failure, tagged `outcome` (error), `reason` (the error's name),
 * `surface` (`cid_cache, block_cache`) and `step` (`read, write, touch, delete, evict, prune, clear`).
 */
const cacheStorageMetric = defineCount<'error'>('cache.storage');

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
      storageReport.expected(error, { step, metric: cacheStorageMetric, attributes });
      return;
    }
    const message = `${tag} ${action} error:`;
    if (captured.has(action)) {
      storageReport.log.error(message, error);
      cacheStorageMetric.count({ ...attributes, outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
      return;
    }
    captured.add(action);
    storageReport.defect(error, {
      step,
      tags: { kind: `${step}_error` },
      metric: cacheStorageMetric,
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
