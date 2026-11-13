// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's own sign-out, in paired and in local mode. It lets the page's sign-in go and has the phone told about the
// session the page holds.

import { createReporter, defineCount } from '@dotli/metrics';
import type { AsyncTaskPool } from '@dotli/shared';
import type { PageCore } from './createPageCore.js';
import type { HostCoreStorage, SessionRead } from './session/createCoreStorage.js';
import type { SessionPresence } from './session/types.js';
import { readWalletOrFailed, type SiteWallet, type WalletRead } from './session/siteWallet.js';
import type { SessionState } from './session/createSessionState.js';
import type { SessionHandoff } from './sessionHandoff/createSessionHandoff.js';
import type { SignInFlag } from './session/signInFlag.js';
import { reportWalletFailure } from './walletFailure.js';
import type { WalletSwitchOutcome } from './createWalletSwitch.js';
import { siteRevokeMetric } from './siteSignIn/siteRevokeMetric.js';

const report = createReporter({ flow: 'wallet' });

/**
 * A page's sign-out of a paired session. Tagged `outcome` (`ok` once the phone was told) and, on error, `reason`:
 * `read` for a copy that could not be read, `end` for a session that could not be activated or ended on the ending
 * core, so the phone was not told, `drop` for a local-mode sign-out whose paired copy could not be dropped, on a page
 * that pairs in place or on a product whose flag is unreadable, where a copy it could not read counts too, and
 * `no_window` for a local-mode sign-out on a page that pairs in place, which lets the paired copy go without telling
 * the phone. A paired sign-out counts once, and a core or copy that could not let go is reported as an issue only.
 */
const walletLogoutMetric = defineCount<'error' | 'ok'>('wallet.logout');

/**
 * How a sign-out ended for the phone: `told` once the phone heard of the session this page held, or there was none,
 * and `untold` when it could not be told. A page reports that and goes on, and the phone keeps this device listed
 * until the user removes it there.
 */
export type LogoutOutcome = { phone: 'told' } | UntoldLogout;

/**
 * A sign-out the phone did not hear of, with what telling it again needs: `end` holds the session that could not be
 * activated or ended, `read` had a copy that could not be read, and `no_window` is a local sign-out on a page that
 * pairs in place, which has nothing to tell the phone with.
 */
export type UntoldLogout =
  { phone: 'untold'; reason: 'end'; blob: string } | { phone: 'untold'; reason: 'read' | 'no_window' };

export type PageSignOut = ReturnType<typeof createPageSignOut>;

export type PageSignOutParams = {
  /** Whether the page runs on a local wallet now. Never throws. */
  isLocalWallet: () => boolean;
  /** The page's copy of the paired session. Its reads never reject. */
  copy: Pick<HostCoreStorage, 'readSession' | 'dropSessionIf'>;
  /**
   * What a paired sign-out's clear of the copy goes through, which moves the signed-in flag as the page's role says.
   */
  flag: Pick<SignInFlag, 'clear'>;
  /**
   * Ends `blob` on a core of the page's own that holds it in memory and follows no store, which tells the phone.
   * Rejects when the core could not boot, install or end it.
   */
  endSession: (blob: string) => Promise<void>;
  /** The page's cores, which drop the session each holds without telling the phone, booting none. */
  cores: Pick<PageCore, 'resetSession'>;
  /** Where the page reports itself signed out. */
  session: Pick<SessionState, 'reportSignedOut'>;
  /**
   * Leaves local wallet mode, which reloads the page, forgetting the wallet through `forget`. A failure is reported
   * there and answered as `failed`.
   */
  leaveLocalWallet: (forget: () => Promise<void>) => Promise<WalletSwitchOutcome>;
  /**
   * Forgets the sites signed in through the session window, which a sign-out that ends the sign-in ends too, or does
   * nothing on a page whose sign-out leaves them to the sign-out window. Rejects when they could not be forgotten.
   */
  forgetGrants: () => Promise<void>;
  /** The main store's local wallet, which a local sign-out reads and then forgets only while it holds that record. */
  wallet: Pick<SiteWallet, 'read' | 'forgetIf'>;
  /**
   * The signed-in flag, which says whether the restore rule clears the paired copy on the load that follows. Never
   * rejects, and reads unknown when it cannot be read.
   */
  presence: Pick<SessionPresence, 'read'>;
  /** Told while a sign-out waits for the sign-out window to read what it ends, which the account button shows. */
  reportSigningOut: (pending: boolean) => void;
  /**
   * The sign-out window, which in local mode tells the phone, so the page leaves local mode once it has read the
   * paired session. Null for a page that pairs in place, which lets the paired copy go untold. Read per sign-out, as
   * the page's role may be chosen after this is built.
   */
  signOutWindow: () => Pick<SessionHandoff, 'signOutRead'> | null;
  /**
   * Where the page's own sign-out runs, one at a time with the restore rule's visible checks, so a check never clears
   * the paired copy the sign-out window still has to read. The wait for that read runs here and not with the logins,
   * so a window that never reads holds up no later login.
   */
  signOuts: AsyncTaskPool;
  /**
   * The core commands' logout: it ends the login round and a pairing under way, then runs `end` in order with logins.
   * Rejects when `end` rejects.
   */
  runOnCore: <T>(end: () => Promise<T>) => Promise<T>;
};

/** A closed set, so the metric's `reason` tag stays bounded. */
type SignOutFailureReason = 'end' | 'reset' | 'drop' | 'grants';

const TOLD: LogoutOutcome = { phone: 'told' };

/** Builds the page's own sign-out. Building it never throws. */
export function createPageSignOut({
  isLocalWallet,
  copy,
  flag,
  endSession,
  cores,
  session,
  leaveLocalWallet,
  forgetGrants,
  wallet,
  presence,
  reportSigningOut,
  signOutWindow,
  signOuts,
  runOnCore,
}: PageSignOutParams) {
  /**
   * Forgets the wallet `held` found while the store still holds that record. Resolves whether it went, and rejects
   * when the wallet could not be read.
   */
  async function forgetWalletRead(held: Promise<WalletRead>): Promise<boolean> {
    const read = await held;
    switch (read.status) {
      case 'failed':
        throw new Error('The local wallet to forget could not be read', { cause: read.error });
      case 'ok':
        return wallet.forgetIf(read.version);
      case 'none':
      case 'unreadable':
        return false;
    }
  }

  /**
   * Lets the paired session go on this page: its cores, then the copy while it still holds `blob`, so a sign-in stored
   * since stays. The page reads as signed out whatever failed, as the flag is already gone.
   */
  async function letGo(blob: string | null): Promise<void> {
    try {
      await cores.resetSession();
    } catch (error) {
      reportLetGoFailure(error, 'reset');
    }
    if (blob !== null) {
      try {
        await flag.clear({ drop: () => copy.dropSessionIf(blob) });
      } catch (error) {
        // The flag is gone, so the next load drops the copy by the restore rule.
        reportLetGoFailure(error, 'drop');
      }
    }
    // At once, so a visible event that follows finds the page signed out before a core reports it.
    session.reportSignedOut();
  }

  /** Forgets the grants. Never rejects, as the sign-out goes on whether or not they went. */
  async function forgetSiteGrants(): Promise<void> {
    try {
      await forgetGrants();
    } catch (error) {
      // The sites keep their tokens until the user revokes them. Counted apart from how the sign-out ended, which this
      // leaves unchanged.
      reportLetGoFailure(error, 'grants');
      siteRevokeMetric.count({ outcome: 'error', reason: 'sign_out' });
    }
  }

  /** Ends `blob` on the phone. A retry runs one at a time with the page's other sign-outs. */
  async function tell(blob: string): Promise<LogoutOutcome> {
    try {
      await endSession(blob);
      walletLogoutMetric.count({ outcome: 'ok' });
      return TOLD;
    } catch (error) {
      // The phone keeps this device listed until the user removes it there.
      reportSignOutFailure(error, 'end');
      return { phone: 'untold', reason: 'end', blob };
    }
  }

  /** Reads the copy and signs out what it holds. */
  function signOutPairedCopy(): Promise<LogoutOutcome> {
    // Before any wait, so the read is ahead of the window's restore rule and of a visible check.
    const held = copy.readSession();
    return signOuts.call(() => runOnCore(() => signOutPaired(held)));
  }

  /**
   * Lets the page's cores and its copy go, then ends the session `held` read on a core of the page's own, which holds
   * it in memory and follows no store, so no clear takes it first. The copy clears through the flag keeper, which moves
   * the flag as the page's role says.
   */
  async function signOutPaired(held: Promise<SessionRead>): Promise<LogoutOutcome> {
    // What there is to end is what the page read, not what a core reports, as a core that follows the store may read
    // signed out once the window cleared it.
    const read = await held;
    const blob = read.status === 'ok' ? read.blob : null;
    await letGo(blob);
    await forgetSiteGrants();
    if (read.status === 'failed') {
      // Core storage reported the read. Nothing can tell the phone without the session.
      report.log.event('logout could not read the paired session');
      walletLogoutMetric.count({ outcome: 'error', reason: 'read' });
      return { phone: 'untold', reason: 'read' };
    }
    return blob === null ? TOLD : tell(blob);
  }

  async function dropPairedCopy(): Promise<void> {
    const read = await copy.readSession();
    if (read.status === 'failed') {
      // Core storage reported the read, so it is counted here and not captured again.
      report.log.event('local sign-out could not read the paired copy to drop it');
      walletLogoutMetric.count({ outcome: 'error', reason: 'drop' });
      return;
    }
    if (read.blob === null) {
      return;
    }
    try {
      await copy.dropSessionIf(read.blob);
    } catch (error) {
      // The wallet still goes. Where the flag is readable, the next load drops the paired copy by the rule.
      reportSignOutFailure(error, 'drop');
    }
  }

  /**
   * A local-mode sign-out on a page that pairs in place, where no core of the page's can end the paired session: its
   * cores are local wallet cores, and the reload that leaves local mode would cut a message to the phone. So the paired
   * copy goes untold, and the phone keeps this device listed until the user removes it there. The copy and then the
   * wallet go through the flag keeper, so the flag drops once the main store holds no sign-in and every app signs out.
   * Each sign-out is counted once, under its most specific reason.
   */
  async function signOutLocalInPlace(heldWallet: Promise<WalletRead>): Promise<LogoutOutcome> {
    const untold = await dropCopyUntold();
    // Before the switch, which reloads the page.
    await forgetSiteGrants();
    // Either outcome ends the sign-out here: the page reloads, or the switch already reported why it stayed.
    await leaveLocalWallet(async () => {
      await flag.clear({ drop: () => forgetWalletRead(heldWallet) });
    });
    return untold ? { phone: 'untold', reason: 'no_window' } : TOLD;
  }

  /**
   * Reads the paired copy and lets what it holds go through the flag keeper, without telling the phone. Resolves
   * whether the copy may have held a session nobody told the phone about, and never rejects, as the local sign-out goes
   * on either way.
   */
  async function dropCopyUntold(): Promise<boolean> {
    const read = await copy.readSession();
    switch (read.status) {
      case 'failed':
        // Core storage reported the read. The copy may still hold a session nobody told the phone about.
        report.log.event('local sign-out could not read the paired session');
        walletLogoutMetric.count({ outcome: 'error', reason: 'read' });
        return true;
      case 'ok': {
        const { blob } = read;
        if (blob === null) {
          return false;
        }
        try {
          await flag.clear({ drop: () => copy.dropSessionIf(blob) });
          report.log.event('local sign-out let the paired session go untold, as the page pairs in place');
          walletLogoutMetric.count({ outcome: 'error', reason: 'no_window' });
        } catch (error) {
          // The wallet still goes, and its clear below leaves the flag up only while the store still holds a sign-in.
          reportSignOutFailure(error, 'drop');
        }
        return true;
      }
    }
  }

  /**
   * A local-mode sign-out on a product, where the sign-out window tells the phone, so the page waits until the window
   * has read the paired session, then leaves local mode.
   */
  async function signOutLocal(heldWallet: Promise<WalletRead>): Promise<LogoutOutcome> {
    // A sign-out ends the paired session too. A local wallet core cannot tell the phone, so the sign-out window does,
    // having read the session from the main store, which in a browser that shares the store is this page's copy. A
    // flag that reads gone has the restore rule clear the copy on the reload, and one set again covers a new sign-in.
    // Only an unreadable flag leaves the copy to this page. Its own clear is not the flag's, since the flag is unknown.
    if ((await presence.read()) === 'unknown') {
      await dropPairedCopy();
    }
    // Before the switch, which reloads the page.
    await forgetSiteGrants();
    // A local session lives only in memory, so signing out means leaving local mode. Either outcome ends the sign-out
    // here: the page reloads, or the switch already reported why it stayed.
    await leaveLocalWallet(async () => {
      await forgetWalletRead(heldWallet);
    });
    return TOLD;
  }

  function signOut(): Promise<LogoutOutcome> {
    report.log.event('logout requested');
    if (!isLocalWallet()) {
      return signOutPairedCopy();
    }
    // Before any wait, so it is the wallet the user signed out of. It never rejects, so it is answered whenever the
    // sign-out gets to it.
    const heldWallet = readWalletOrFailed(() => wallet.read());
    const handoff = signOutWindow();
    if (handoff === null) {
      return signOuts.call(() => runOnCore(() => signOutLocalInPlace(heldWallet)));
    }
    // Before the queue, so the sign-out waits on the window open when it was asked and not on one a later click
    // opens.
    const windowRead = handoff.signOutRead();
    return signOuts.call(async () => {
      reportSigningOut(true);
      await windowRead;
      reportSigningOut(false);
      return runOnCore(() => signOutLocal(heldWallet));
    });
  }

  function tellAgain(untold: UntoldLogout): Promise<LogoutOutcome> {
    switch (untold.reason) {
      case 'end': {
        const { blob } = untold;
        return signOuts.call(() => tell(blob));
      }
      case 'read':
        return signOutPairedCopy();
      case 'no_window':
        return Promise.resolve(untold);
    }
  }

  async function signOutLocally(): Promise<void> {
    if (isLocalWallet()) {
      // The watch found the wallet gone, so nothing is forgotten here, and a wallet saved since stays. A failed
      // switch was reported there and left the page as it was.
      if ((await leaveLocalWallet(() => Promise.resolve())) === 'failed') {
        throw new Error('The local wallet could not be forgotten');
      }
      return;
    }
    // Only a core already running holds the session, so none is booted just to drop it.
    await cores.resetSession();
    session.reportSignedOut();
  }

  return {
    /**
     * Signs this page out and has the phone told. A product signs out once the sign-out window opened and the signed-in
     * flag went in the click's turn. A page that pairs in place, the landing page or a preview, opens no window and
     * moves the flag through its flag keeper as it clears the copy. In paired mode it reads the copy before it returns,
     * in the click's continuation, so the read reaches the protocol frame ahead of any window's restore rule and of any
     * visible check, which may clear the copy. In local mode it reads the wallet in the click's turn and forgets only
     * that record, so a wallet another tab saves meanwhile stays. Settles once the sign-out ended, having reported its
     * own failures, with whether the phone heard of the session this page held. On a product in local mode the sign-out
     * window tells the phone, so it answers `told`.
     */
    signOut,
    /**
     * Tries once more to tell the phone of the sign-out `untold` says it missed, one at a time with the page's other
     * sign-outs: it ends the same session again, or reads the copy again and signs out what it holds. A page that pairs
     * in place has nothing to tell with, so it answers `untold` as it is. Settles with the new outcome, having reported
     * its own failures.
     */
    tellAgain,
    /**
     * Ends this page's sign-in without telling the phone, for one signed out elsewhere whose copy the restore rule
     * already cleared. Leaving local mode reloads the page. Rejects when the sign-in could not be ended.
     */
    signOutLocally,
  };
}

function reportSignOutFailure(error: unknown, reason: SignOutFailureReason): void {
  reportWalletFailure(error, { what: `logout ${reason}`, step: 'logout', reason, metric: walletLogoutMetric });
}

/** Reports a failure of the let-go as an issue only, as the sign-out counts its own outcome once. */
function reportLetGoFailure(error: unknown, reason: SignOutFailureReason): void {
  reportWalletFailure(error, { what: `logout ${reason}`, step: 'logout', reason });
}
