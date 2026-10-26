// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps one page core lease while the page's copy holds a paired session, so a page with no product of its own still
// hears the phone end the session. It follows the copy, never the auth store, acts only at start, on a change of the
// copy and when its core goes down, and never retries on a timer.

import { m, reportExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool } from '@dotli/shared';
import { CoreRedialError, type CoreLease } from '../page-core.js';
import type { WalletMode } from '../state/wallet-mode.js';
import { reportWalletFailure } from '../wallet-failure.js';
import type { HostCoreStorage } from './core-storage.js';

type HeldLease = Pick<CoreLease, 'subscribeDown' | 'release'>;

export interface SessionLeaseDeps {
  copy: Pick<HostCoreStorage, 'readSession' | 'onStoredSessionChanged'>;
  walletMode: () => WalletMode;
  /** Only the two lease calls the session lease makes. */
  core: { acquire(): Promise<HeldLease> };
}

export interface SessionLease {
  /**
   * Holds a lease while the copy holds a paired session. A second call returns the first one's stop. The stop is final:
   * a start after it starts nothing.
   */
  start(): () => void;
}

export function createSessionLease(deps: SessionLeaseDeps): SessionLease {
  // One run at a time, so a run never sees the lease another run is taking.
  const runs = createAsyncTaskPool({ poolSize: 1 });
  let stopped = false;
  // Read through a call, as the stop flips it across the awaits of a run.
  const isStopped = (): boolean => stopped;
  let held: HeldLease | null = null;
  let stop: (() => void) | null = null;

  const releaseHeld = (): void => {
    held?.release();
    held = null;
  };

  const run = async (): Promise<void> => {
    if (isStopped()) {
      releaseHeld();
      return;
    }
    const read = await deps.copy.readSession();
    if (isStopped() || read.status === 'failed') {
      return;
    }
    const wanted = read.blob !== null && deps.walletMode() === 'app';
    if (!wanted) {
      releaseHeld();
      return;
    }
    if (held !== null) {
      return;
    }
    let lease: HeldLease;
    try {
      lease = await deps.core.acquire();
    } catch (error) {
      if (error instanceof CoreRedialError) {
        reportExpected(error, {
          flow: 'wallet',
          step: 'session_lease',
          metric: S.WALLET_SESSION_LEASE,
          reason: 'redial',
        });
      } else {
        reportWalletFailure(error, {
          what: 'session lease boot',
          step: 'session_lease',
          reason: 'boot',
          metric: S.WALLET_SESSION_LEASE,
        });
      }
      return;
    }
    m.count(S.WALLET_SESSION_LEASE, { outcome: 'ok' });
    if (isStopped() || deps.walletMode() !== 'app') {
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
  };

  return {
    start() {
      if (stop !== null) {
        return stop;
      }
      void runs.call(run);
      const stopChanges = deps.copy.onStoredSessionChanged(() => {
        void runs.call(run);
      });
      stop = () => {
        stopped = true;
        releaseHeld();
        stopChanges();
      };
      return stop;
    },
  };
}
