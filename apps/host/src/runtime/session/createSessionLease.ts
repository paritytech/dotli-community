// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps one page core lease while the page's copy holds a paired session, so a page with no product of its own still
// hears the phone end the session. It follows the copy, never the auth store, acts only at start, on a change of the
// copy and when its core goes down, and never retries on a timer.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool } from '@dotli/shared';
import { CoreRedialError } from '../coreRedialError.js';
import type { CoreLease } from '../createPageCore.js';
import { reportWalletFailure } from '../walletFailure.js';
import type { HostCoreStorage } from './createCoreStorage.js';

const report = createReporter({ flow: 'wallet' });

/**
 * One `acquire` the session lease made of the page core. Tagged `outcome` (ok or error) and, on error, `reason`: `boot`
 * for a first boot that failed and `redial` for a replacement that could not boot.
 */
const walletSessionLeaseMetric = defineCount<'error' | 'ok'>('wallet.session_lease');

type HeldLease = Pick<CoreLease, 'subscribeDown' | 'release'>;

type Params = {
  /** The page's copy, whose paired session the lease follows. */
  copy: Pick<HostCoreStorage, 'readSession' | 'subscribeStoredSession'>;
  /** Whether the page runs on a local wallet now, as only a page that pairs holds a lease. Never throws. */
  isLocalWallet: () => boolean;
  /**
   * Only the two lease calls the session lease makes. `acquire` rejects with `CoreRedialError` when the core the page
   * redialed could not boot, and with the boot's error when the core it dials cannot boot.
   */
  core: { acquire(): Promise<HeldLease> };
};

export function createSessionLease({ copy, isLocalWallet, core }: Params) {
  // One run at a time, so a run never sees the lease another run is taking.
  const runs = createAsyncTaskPool({ poolSize: 1 });
  let stopped = false;
  let held: HeldLease | null = null;
  let stop: (() => void) | null = null;

  // Read through a call, as the stop flips it across the awaits of a run.
  function isStopped(): boolean {
    return stopped;
  }

  function releaseHeld(): void {
    held?.release();
    held = null;
  }

  async function run(): Promise<void> {
    if (isStopped()) {
      releaseHeld();
      return;
    }
    const read = await copy.readSession();
    if (isStopped() || read.status === 'failed') {
      return;
    }
    const wanted = read.blob !== null && !isLocalWallet();
    if (!wanted) {
      releaseHeld();
      return;
    }
    if (held !== null) {
      return;
    }
    let lease: HeldLease;
    try {
      lease = await core.acquire();
    } catch (error) {
      reportAcquireFailure(error);
      return;
    }
    walletSessionLeaseMetric.count({ outcome: 'ok' });
    if (isStopped() || isLocalWallet()) {
      lease.release();
      return;
    }
    // Held before the subscribe, which calls the listener at once for a core that went down since it was acquired.
    held = lease;
    // Acts only for the lease still held, as a down report can arrive for a lease already released or replaced.
    lease.subscribeDown(() => {
      if (held !== lease) {
        return;
      }
      releaseHeld();
      void runs.call(run);
    });
  }

  return {
    /**
     * Holds a lease while the copy holds a paired session. A second call returns the first one's stop. The stop is
     * final: a start after it starts nothing.
     */
    start(): () => void {
      if (stop !== null) {
        return stop;
      }
      void runs.call(run);
      const stopChanges = copy.subscribeStoredSession(() => {
        void runs.call(run);
      });

      function stopLease(): void {
        stopped = true;
        releaseHeld();
        stopChanges();
      }

      stop = stopLease;
      return stop;
    },
  };
}

function reportAcquireFailure(error: unknown): void {
  if (error instanceof CoreRedialError) {
    report.expected(error, {
      step: 'session_lease',
      metric: walletSessionLeaseMetric,
      reason: 'redial',
    });
    return;
  }
  reportWalletFailure(error, {
    what: 'session lease boot',
    step: 'session_lease',
    reason: 'boot',
    metric: walletSessionLeaseMetric,
  });
}
