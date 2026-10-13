// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';
import { captureException, recordExpected } from '@dotli/metrics';
import { isExpectedDbError } from './db.js';

/**
 * Reports one cache's storage failures. A fault is captured once per action for the reporter's life, since a stuck
 * cache fails identically on every access.
 */
export function createCacheReporter(cache: string, tag: string): (action: string, err: unknown) => void {
  const captured = new Set<string>();
  return (action, err) => {
    const step = `${cache}_${action}`;
    if (isExpectedDbError(err)) {
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
