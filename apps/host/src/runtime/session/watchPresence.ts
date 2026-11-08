// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The restore rule again on an open page each time its sign-in may have changed elsewhere, so a tab or window left
// open drops an account signed out elsewhere.

import { createReporter, defineCount } from '@dotli/metrics';
import { areBytesEqual, createAsyncTaskPool, realTimers, type AsyncTaskPool, type Timers } from '@dotli/shared';
import { reportWalletFailure } from '../walletFailure.js';
import type { Presence } from './types.js';
import type { Reconciled } from './restoreRule.js';
import { recordPresenceWalletReadFailure } from './siteWallet.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. What an open page did as it became visible and found the signed-in flag changed. Tagged `outcome`:
 * `signed_out` for a page it signed out, `switched` for a page it reloads onto a local wallet replaced elsewhere, and
 * `error` for a sign-out that failed after its retries. Tagged `reason` (`visible`).
 */
const sessionPresenceWatchMetric = defineCount<'error' | 'signed_out' | 'switched'>('session.presence_watch');

type Params = {
  /**
   * Calls the listener each time the sign-in may have changed: the flag's own change event, a change of the local
   * wallet in another tab, or the user coming back. Returns the unsubscribe.
   */
  subscribeRecheck: (listener: () => void) => () => void;
  /** Whether the page shows a sign-in now. */
  isSignedIn: () => boolean;
  /**
   * Where the page's own sign-out runs. A check queues there, one at a time, so it never clears the paired copy a
   * sign-out under way still needs, and a recheck during a sign-out finds the page signed out.
   */
  signOuts: AsyncTaskPool;
  /** The restore rule over the page's copy, which clears a stored sign-in the flag says is gone. Never rejects. */
  reconcile: () => Promise<Pick<Reconciled, 'presence' | 'wallet'>>;
  /**
   * The version of the local wallet record the page runs on, or null for a page that pairs. Never rejects, as a wallet
   * read that failed reads as none.
   */
  readPageWalletVersion: () => Promise<Uint8Array | null>;
  /** Reloads the page onto the wallet the store holds now. */
  followWallet: () => void;
  /**
   * Ends this page's sign-in after a sign-out made elsewhere, without telling the phone. The page reads as
   * signed out once it settles, and it rejects when the sign-in could not be ended.
   */
  signOutLocally: () => Promise<void>;
  /** Reads the flag. Never rejects, taking a failed read as unknown. */
  readFlag: () => Promise<Presence>;
  /** Where the flag read on a page that holds no sign-in goes. */
  reportFlag: (presence: Presence) => void;
  /** The timers the waits between tries of a failed sign-out run on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

/** What a recheck makes of a signed-in page: it stays, signs out, or follows the wallet another tab saved. */
type Verdict = 'keep' | 'signed_out' | 'switched';

/** How many times a local sign-out that failed is tried again. */
const SIGN_OUT_RETRIES = 3;

/** The page's own sign-out rejected, the one failure of a check that another try may cure. */
class LocalSignOutFailed extends Error {}

/**
 * Applies the restore rule each time the flag changes, where the browser says so, each time the user comes back to the
 * page, and each time another tab changes the local wallet. A page on a local wallet keeps it while the store does, as
 * only a sign-out forgets one, and reloads onto another wallet a tab saved since, so it runs on the wallet the store
 * holds. A page that holds no sign-in reads the flag instead, so it can say whether a sign-in made elsewhere waits for
 * it. A sign-out of the page that fails is tried again a few times before it is reported.
 */
export function watchPresence({
  subscribeRecheck,
  isSignedIn,
  signOuts,
  reconcile,
  readPageWalletVersion,
  followWallet,
  signOutLocally,
  readFlag,
  reportFlag,
  timers = realTimers,
}: Params): () => void {
  // A failed sign-out leaves the page signed in, so the watch tries again on its own rather than wait for the next
  // recheck. Each try queues a fresh check on the page's sign-outs and reads the state again, and the wait between
  // tries holds no sign-out slot.
  const rechecks = createAsyncTaskPool({
    poolSize: 1,
    retryCount: SIGN_OUT_RETRIES,
    retryDelay: getRetryDelayMs,
    retryIf: error => error instanceof LocalSignOutFailed,
    timers,
  });
  let current = new AbortController();

  // Each recheck queues one check. A check on a page already signed out only reads the flag, so the checks queued
  // behind a sign-out, which leaves the page signed out or reloads it, clear nothing.
  async function check(): Promise<void> {
    if (!isSignedIn()) {
      reportFlag(await readFlag());
      return;
    }
    const reconciled = await reconcile();
    if (reconciled.wallet.status === 'failed') {
      recordPresenceWalletReadFailure(reconciled.wallet.error);
    }
    switch (getVerdict(await readPageWalletVersion(), reconciled)) {
      case 'keep':
        return;
      case 'switched':
        report.log.event('local wallet replaced elsewhere, reloading onto it');
        sessionPresenceWatchMetric.count({ outcome: 'switched', reason: 'visible' });
        followWallet();
        return;
      case 'signed_out':
        await signOutPage();
        return;
    }
  }

  async function signOutPage(): Promise<void> {
    report.log.event('signed out elsewhere, signing out this page');
    try {
      await signOutLocally();
    } catch (error) {
      throw new LocalSignOutFailed('Could not sign this page out', { cause: error });
    }
    sessionPresenceWatchMetric.count({ outcome: 'signed_out', reason: 'visible' });
  }

  function recheck(): void {
    // A newer recheck reads the state again, so the chain before it stops retrying.
    current.abort();
    current = new AbortController();
    const { signal } = current;
    // The signal stays off the sign-outs call: an abort there would free the slot while the check still runs, and
    // let a sign-out of the page run beside it.
    rechecks
      .call(() => signOuts.call(check), { pool: 'presence_recheck', signal })
      .catch((error: unknown) => {
        if (signal.aborted) {
          return;
        }
        // Only the sign-out is retried, so any other failure of the check is its own issue.
        const signOut = error instanceof LocalSignOutFailed;
        reportWalletFailure(signOut ? error.cause : error, {
          what: signOut ? 'local sign-out' : 'presence check',
          step: signOut ? 'presence_signout' : 'presence_check',
          reason: 'visible',
          metric: sessionPresenceWatchMetric,
        });
      });
  }

  const unsubscribe = subscribeRecheck(recheck);

  function dispose(): void {
    unsubscribe();
    current.abort();
  }

  return dispose;
}

/**
 * Decides what a recheck does with the page. Only a sign-out forgets a local wallet, so the wallet read decides for a
 * page on one, whatever the flag says, as another sign-in may keep the flag up. A read that failed or found the record
 * unreadable keeps it, since the wallet may still be stored, and the next recheck tells. Every save draws a new
 * version, so another one is another wallet saved since.
 */
function getVerdict(page: Uint8Array | null, { presence, wallet }: Pick<Reconciled, 'presence' | 'wallet'>): Verdict {
  if (page === null) {
    return presence === 'absent' ? 'signed_out' : 'keep';
  }
  switch (wallet.status) {
    case 'none':
      return 'signed_out';
    case 'ok':
      return areBytesEqual(wallet.version, page) ? 'keep' : 'switched';
    case 'unreadable':
    case 'failed':
      return 'keep';
  }
}

/** The wait before each retry of a local sign-out that failed, four times the one before: 1, 4 and 16 seconds. */
function getRetryDelayMs(retry: number): number {
  return 1000 * 4 ** retry;
}
