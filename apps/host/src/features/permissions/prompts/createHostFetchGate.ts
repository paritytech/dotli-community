// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a product's worker may fetch from a host. dot.li keeps these grants itself, as the core has no permission
// for a URL.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool } from '@dotli/shared';
import {
  fetchGrants,
  isExpectedDbError,
  type FetchGrant,
  type FetchGrantKey,
  type FetchGrantStore,
} from '@dotli/storage';
import type { BlockingModalScope } from '../../../kit/createBlockingModalCoordinator.js';
import { hostPrompts } from './createHostPrompts.js';
import type { GrantAnswer, HostPrompts } from './hostPrompts.js';

const report = createReporter({ flow: 'permissions' });

/**
 * A worker's fetch denied because its grant could not be read or saved. Tagged `outcome` (error) and `reason` (the
 * error's name).
 */
const fetchGrantStorageMetric = defineCount<'error'>('permissions.fetch_grant_storage');

/** A worker's fetch denied because the user could not be asked. Tagged `outcome` (error) and `reason`. */
const fetchGrantAskMetric = defineCount<'error'>('permissions.fetch_grant_ask');

type Params = {
  /** The product whose worker fetches. */
  label: string;
  /** Where the asks queue with the page's other prompts. Disposing it denies the asks still open. */
  scope: Pick<BlockingModalScope, 'enqueue'>;
  /** Shows the ask. The page's own prompts by default. */
  prompts?: Pick<HostPrompts, 'askHostAccess'>;
  /** The user's lasting decisions. The page's own by default. */
  grants?: Pick<FetchGrantStore, 'read' | 'save'>;
};

/**
 * The gate of one worker run of `label`. A stored decision answers at once, and with none the user is asked. Allow
 * always and Deny are stored, Allow once lasts as long as the gate, and a dismissal denies the fetches that waited on
 * it and stores nothing.
 */
export function createHostFetchGate({ label, scope, prompts = hostPrompts, grants = fetchGrants }: Params) {
  // One pool per host, so the calls for a host made while it is asked wait behind the ask and take its verdict.
  const asks = createAsyncTaskPool({ poolSize: 1 });
  const allowedOnce = new Set<string>();
  // Each host's last asked verdict, and the count of verdicts when it settled, so a call that waited on that ask finds
  // its verdict, while a later call asks again.
  const verdicts = new Map<string, { allowed: boolean; at: number }>();
  let verdictCount = 0;

  async function decide(host: string, calledAt: number): Promise<boolean> {
    if (allowedOnce.has(host)) {
      return true;
    }
    const verdict = verdicts.get(host);
    if (verdict !== undefined && verdict.at > calledAt) {
      return verdict.allowed;
    }
    const key: FetchGrantKey = { label, host };
    let stored: FetchGrant | null;
    try {
      stored = await grants.read(key);
    } catch (error) {
      reportStorageFailure(error, 'fetch_grant_read');
      return false;
    }
    switch (stored) {
      case 'allowed':
        return true;
      case 'denied':
        return false;
      case null:
        break;
    }
    const allowed = await askUser(key);
    verdictCount += 1;
    verdicts.set(host, { allowed, at: verdictCount });
    return allowed;
  }

  async function askUser(key: FetchGrantKey): Promise<boolean> {
    let answer: GrantAnswer;
    try {
      answer = await scope.enqueue(signal => prompts.askHostAccess({ ...key, signal }));
    } catch (error) {
      // The run the scope belongs to has ended, so nobody waits on the fetch.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        report.defect(error, {
          step: 'fetch_grant_ask',
          metric: fetchGrantAskMetric,
          message: '[dot.li permissions] Asking for a fetch grant failed:',
        });
      }
      return false;
    }
    switch (answer) {
      case 'granted':
        return isSaved(key, 'allowed');
      case 'denied':
        await isSaved(key, 'denied');
        return false;
      case 'granted-once':
        allowedOnce.add(key.host);
        return true;
      case 'dismissed':
        return false;
    }
  }

  /** Stores `grant`, and resolves false when that failed. */
  async function isSaved(key: FetchGrantKey, grant: FetchGrant): Promise<boolean> {
    try {
      await grants.save(key, grant);
    } catch (error) {
      reportStorageFailure(error, 'fetch_grant_write');
      return false;
    }
    return true;
  }

  return {
    /**
     * Resolves whether the worker may fetch from `host`, as a URL names it. Never rejects: a grant that cannot be read
     * or saved, or an ask that fails, denies.
     */
    isHostAllowed(host: string): Promise<boolean> {
      const calledAt = verdictCount;
      return asks.call(() => decide(host, calledAt), { pool: host });
    },
  };
}

function reportStorageFailure(error: unknown, step: 'fetch_grant_read' | 'fetch_grant_write'): void {
  if (isExpectedDbError(error)) {
    report.expected(error, { step, metric: fetchGrantStorageMetric });
    return;
  }
  report.defect(error, {
    step,
    metric: fetchGrantStorageMetric,
    message: `[dot.li permissions] ${step} failed:`,
  });
}
