// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The restore rule again on an open page each time its sign-in may have changed elsewhere, so a tab or window left
// open drops an account signed out elsewhere.

import { m, recordExpected, spans as S } from '@dotli/metrics';
import { bytesEqual, createAsyncTaskPool, log, realTimers, type AsyncTaskPool, type Timers } from '@dotli/shared';
import { reportWalletFailure } from '../wallet-failure.js';
import type { Presence } from './presence.js';
import type { Reconciled } from './restore-rule.js';

export type PresenceWatchDeps = {
  /**
   * Calls the listener each time the sign-in may have changed: the flag's own change event, a change of the local
   * wallet in another tab, or the user coming back. Returns the unsubscribe.
   */
  onRecheck: (listener: () => void) => () => void;
  signedIn: () => boolean;
  /**
   * Where the page's own sign-out runs. A check queues there, one at a time, so it never clears the paired copy a
   * sign-out under way still needs, and a recheck during a sign-out finds the page signed out.
   */
  signOuts: AsyncTaskPool;
  /** The restore rule over the page's copy, which clears a stored sign-in the flag says is gone. Never rejects. */
  reconcile: () => Promise<Pick<Reconciled, 'presence' | 'wallet'>>;
  /** The version of the local wallet record the page runs on, or null for a page that pairs. */
  pageWallet: () => Promise<Uint8Array | null>;
  /** Reloads the page onto the wallet the store holds now. */
  followWallet: () => void;
  /**
   * Ends this page's sign-in without telling the phone, which the page that signed out already did. The page reads as
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

/** How many times a local sign-out that failed is tried again. */
const SIGN_OUT_RETRIES = 3;

/** The wait before each retry of a local sign-out that failed, four times the one before: 1, 4 and 16 seconds. */
const retryDelayMs = (retry: number): number => 1000 * 4 ** retry;

/** The page's own sign-out rejected, the one failure of a check that another try may cure. */
class LocalSignOutFailed extends Error {}

/** What a recheck makes of a signed-in page: it stays, signs out, or follows the wallet another tab saved. */
type Verdict = 'keep' | 'signed_out' | 'switched';

/**
 * Decides what a recheck does with the page. Only a sign-out forgets a local wallet, so the wallet read decides for a
 * page on one, whatever the flag says, as another sign-in may keep the flag up. A read that failed or found the record
 * unreadable keeps it, since the wallet may still be stored, and the next recheck tells. Every save draws a new
 * version, so another one is another wallet saved since.
 */
function verdictOf(page: Uint8Array | null, { presence, wallet }: Pick<Reconciled, 'presence' | 'wallet'>): Verdict {
  if (page === null) {
    return presence === 'absent' ? 'signed_out' : 'keep';
  }
  if (wallet.status === 'none') {
    return 'signed_out';
  }
  return wallet.status === 'ok' && !bytesEqual(wallet.version, page) ? 'switched' : 'keep';
}

/**
 * Applies the restore rule each time the flag changes, where the browser says so, each time the user comes back to the
 * page, and each time another tab changes the local wallet. A page on a local wallet keeps it while the store does, as
 * only a sign-out forgets one, and reloads onto another wallet a tab saved since, so it runs on the wallet the store
 * holds. A page that holds no sign-in reads the flag instead, so it can say whether a sign-in made elsewhere waits for
 * it. A sign-out of the page that fails is tried again a few times before it is reported.
 */
export function watchPresence(deps: PresenceWatchDeps): () => void {
  // Each recheck queues one check. A check on a page already signed out only reads the flag, so the checks queued
  // behind a sign-out, which leaves the page signed out or reloads it, clear nothing.
  const check = async (): Promise<void> => {
    if (!deps.signedIn()) {
      deps.reportFlag(await deps.readFlag());
      return;
    }
    const reconciled = await deps.reconcile();
    if (reconciled.wallet.status === 'failed') {
      recordExpected(reconciled.wallet.error, { flow: 'wallet', step: 'presence_wallet_read' });
    }
    const verdict = verdictOf(await deps.pageWallet(), reconciled);
    if (verdict === 'keep') {
      return;
    }
    if (verdict === 'switched') {
      log.event('local wallet replaced elsewhere, reloading onto it', { flow: 'wallet' });
      m.count(S.SESSION_PRESENCE_WATCH, { outcome: 'switched', reason: 'visible' });
      deps.followWallet();
      return;
    }
    log.event('signed out elsewhere, signing out this page', { flow: 'wallet' });
    try {
      await deps.signOutLocally();
    } catch (error) {
      throw new LocalSignOutFailed('Could not sign this page out', { cause: error });
    }
    m.count(S.SESSION_PRESENCE_WATCH, { outcome: 'signed_out', reason: 'visible' });
  };
  // A failed sign-out leaves the page signed in, so the watch tries again on its own rather than wait for the next
  // recheck. Each try queues a fresh check on the page's sign-outs and reads the state again, and the wait between
  // tries holds no sign-out slot.
  const rechecks = createAsyncTaskPool({
    poolSize: 1,
    retryCount: SIGN_OUT_RETRIES,
    retryDelay: retryDelayMs,
    retryIf: error => error instanceof LocalSignOutFailed,
    timers: deps.timers ?? realTimers,
  });
  let current = new AbortController();
  const recheck = (): void => {
    // A newer recheck reads the state again, so the chain before it stops retrying.
    current.abort();
    current = new AbortController();
    const { signal } = current;
    // The signal stays off the sign-outs call: an abort there would free the slot while the check still runs, and
    // let a sign-out of the page run beside it.
    rechecks
      .call(() => deps.signOuts.call(check), { pool: 'presence_recheck', signal })
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
          metric: S.SESSION_PRESENCE_WATCH,
        });
      });
  };
  const unsubscribe = deps.onRecheck(recheck);
  return () => {
    unsubscribe();
    current.abort();
  };
}
