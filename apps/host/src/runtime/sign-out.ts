// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's own sign-out, in paired and in local mode. It lets the page's sign-in go and has the phone told about the
// session the page holds.

import { m, spans as S } from '@dotli/metrics';
import { log, type AsyncTaskPool } from '@dotli/shared';
import type { PageCore } from './page-core.js';
import type { HostCoreStorage, SessionRead } from './session/core-storage.js';
import type { SessionPresence } from './session/presence.js';
import { readWalletOrFailed, type SiteWallet, type WalletRead } from './session/site-wallet.js';
import type { SessionState } from './session/session-state.js';
import type { SessionHandoff } from './session-handoff/opener.js';
import type { SignInFlag } from './session/sign-in-flag.js';
import type { WalletMode } from './state/wallet-mode.js';
import { reportWalletFailure } from './wallet-failure.js';
import type { WalletSwitchOutcome } from './wallet-switch.js';

/**
 * How a sign-out ended for the phone: `told` once the phone heard of the session this page held, or there was none,
 * and `untold` when the session could not be read, activated or ended. A page reports that and goes on, and the phone
 * keeps this device listed until the user removes it there. `tellAgain` tries once more for a caller that lets the
 * user retry, and holds the session only as long as that caller keeps it.
 */
export type LogoutOutcome = { phone: 'told' } | { phone: 'untold'; tellAgain: () => Promise<LogoutOutcome> };

const TOLD: LogoutOutcome = { phone: 'told' };

const NOTHING_TO_FORGET = (): Promise<void> => Promise.resolve();

/** A page that pairs in place has nothing to tell the phone with in local mode, so telling again answers the same. */
const UNTOLD_IN_PLACE: LogoutOutcome = { phone: 'untold', tellAgain: () => Promise.resolve(UNTOLD_IN_PLACE) };

export type PageSignOutDeps = {
  walletMode: () => WalletMode;
  /** The page's copy of the paired session. Its reads never reject. */
  copy: Pick<HostCoreStorage, 'readSession' | 'dropSessionIf'>;
  /**
   * What a paired sign-out's clear of the copy goes through, which moves the signed-in flag as the page's role says.
   */
  flag: Pick<SignInFlag, 'clear'>;
  /**
   * Ends `blob` on a core of the page's own that holds it in memory and follows no store, which tells the phone.
   */
  endSession: (blob: string) => Promise<void>;
  /** The page's cores, which drop the session each holds without telling the phone, booting none. */
  cores: Pick<PageCore, 'resetSession'>;
  session: Pick<SessionState, 'reportSignedOut'>;
  /**
   * Leaves local wallet mode, which reloads the page, forgetting the wallet through `forget`. A failure is reported
   * there and answered as `failed`.
   */
  leaveLocalWallet: (forget: () => Promise<void>) => Promise<WalletSwitchOutcome>;
  /**
   * Forgets the sites signed in through the session window, which a sign-out that ends the sign-in ends too, or does
   * nothing on a page whose sign-out leaves them to the sign-out window.
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
   */
  onCore: <T>(end: () => Promise<T>) => Promise<T>;
};

export type PageSignOut = {
  /**
   * Signs this page out and has the phone told. A product signs out once the sign-out window opened and the signed-in
   * flag went in the click's turn. A page that pairs in place, the landing page or a preview, opens no window and moves
   * the flag through its flag keeper as it clears the copy. In paired mode it reads the copy before it returns, in the
   * click's continuation, so the read reaches the protocol frame ahead of any window's restore rule and of any visible
   * check, which may clear the copy. In local mode it reads the wallet in the click's turn and forgets only that
   * record, so a wallet another tab saves meanwhile stays. Settles once the sign-out ended, having reported its own
   * failures, with whether the phone heard of the session this page held. On a product in local mode the sign-out
   * window tells the phone, so it answers `told`.
   */
  signOut(): Promise<LogoutOutcome>;
  /**
   * Ends this page's sign-in without telling the phone, for one signed out elsewhere whose copy the restore rule
   * already cleared. Leaving local mode reloads the page. Rejects when the sign-in could not be ended.
   */
  signOutLocally(): Promise<void>;
};

/** A closed set, so the metric's `reason` tag stays bounded. */
type SignOutFailureReason = 'end' | 'reset' | 'drop' | 'grants';

function reportSignOutFailure(error: unknown, reason: SignOutFailureReason): void {
  reportWalletFailure(error, { what: `logout ${reason}`, step: 'logout', reason, metric: S.WALLET_LOGOUT });
}

/** Reports a failure of the let-go as an issue only, as the sign-out counts its own outcome once. */
function reportLetGoFailure(error: unknown, reason: SignOutFailureReason): void {
  reportWalletFailure(error, { what: `logout ${reason}`, step: 'logout', reason });
}

export function createPageSignOut(deps: PageSignOutDeps): PageSignOut {
  /** Never rejects, so a read made in the click's turn is answered whenever the sign-out gets to it. */
  const readWallet = (): Promise<WalletRead> => readWalletOrFailed(() => deps.wallet.read());

  /** Forgets the wallet `held` found while the store still holds that record. Resolves whether it went. */
  const forgetWalletRead = async (held: Promise<WalletRead>): Promise<boolean> => {
    const wallet = await held;
    if (wallet.status === 'failed') {
      throw new Error('The local wallet to forget could not be read', { cause: wallet.error });
    }
    return wallet.status === 'ok' ? deps.wallet.forgetIf(wallet.version) : false;
  };

  /**
   * Lets the paired session go on this page: its cores, then the copy while it still holds `blob`, so a sign-in stored
   * since stays. The page reads as signed out whatever failed, as the flag is already gone.
   */
  const letGo = async (blob: string | null): Promise<void> => {
    try {
      await deps.cores.resetSession();
    } catch (error) {
      reportLetGoFailure(error, 'reset');
    }
    if (blob !== null) {
      try {
        await deps.flag.clear(() => deps.copy.dropSessionIf(blob));
      } catch (error) {
        // The flag is gone, so the next load drops the copy by the restore rule.
        reportLetGoFailure(error, 'drop');
      }
    }
    // At once, so a visible event that follows finds the page signed out before a core reports it.
    deps.session.reportSignedOut();
  };

  /** Forgets the grants. Never rejects, as the sign-out goes on whether or not they went. */
  const forgetGrants = async (): Promise<void> => {
    try {
      await deps.forgetGrants();
    } catch (error) {
      // The sites keep their tokens until the user revokes them. Counted apart from how the sign-out ended, which this
      // leaves unchanged.
      reportLetGoFailure(error, 'grants');
      m.count(S.SITE_REVOKE, { outcome: 'error', reason: 'sign_out' });
    }
  };

  /** Ends `blob` on the phone. A retry runs one at a time with the page's other sign-outs. */
  const tell = async (blob: string): Promise<LogoutOutcome> => {
    try {
      await deps.endSession(blob);
      m.count(S.WALLET_LOGOUT, { outcome: 'ok' });
      return TOLD;
    } catch (error) {
      // The phone keeps this device listed until the user removes it there.
      reportSignOutFailure(error, 'end');
      return { phone: 'untold', tellAgain: () => deps.signOuts.call(() => tell(blob)) };
    }
  };

  /** Reads the copy again and signs out what it holds, for a sign-out whose read failed. */
  const signOutAgain = (): Promise<LogoutOutcome> => {
    const held = deps.copy.readSession();
    return deps.signOuts.call(() => deps.onCore(() => signOutPaired(held)));
  };

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
    await forgetGrants();
    if (read.status === 'failed') {
      // Core storage reported the read. Nothing can tell the phone without the session.
      log.event('logout could not read the paired session', { flow: 'wallet' });
      m.count(S.WALLET_LOGOUT, { outcome: 'error', reason: 'read' });
      return { phone: 'untold', tellAgain: signOutAgain };
    }
    return blob === null ? TOLD : tell(blob);
  }

  async function dropPairedCopy(): Promise<void> {
    const read = await deps.copy.readSession();
    if (read.status === 'failed') {
      reportSignOutFailure(read.error, 'drop');
      return;
    }
    if (read.blob === null) {
      return;
    }
    try {
      await deps.copy.dropSessionIf(read.blob);
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
  async function signOutLocalInPlace(wallet: Promise<WalletRead>): Promise<LogoutOutcome> {
    const read = await deps.copy.readSession();
    let untold = true;
    if (read.status === 'failed') {
      // Core storage reported the read. The copy may still hold a session nobody told the phone about.
      log.event('local sign-out could not read the paired session', { flow: 'wallet' });
      m.count(S.WALLET_LOGOUT, { outcome: 'error', reason: 'read' });
    } else if (read.blob === null) {
      untold = false;
    } else {
      const { blob } = read;
      try {
        await deps.flag.clear(() => deps.copy.dropSessionIf(blob));
        log.event('local sign-out let the paired session go untold, as the page pairs in place', { flow: 'wallet' });
        m.count(S.WALLET_LOGOUT, { outcome: 'error', reason: 'no_window' });
      } catch (error) {
        // The wallet still goes, and its clear below leaves the flag up only while the store still holds a sign-in.
        reportSignOutFailure(error, 'drop');
      }
    }
    // Before the switch, which reloads the page.
    await forgetGrants();
    // Either outcome ends the sign-out here: the page reloads, or the switch already reported why it stayed.
    await deps.leaveLocalWallet(async () => {
      await deps.flag.clear(() => forgetWalletRead(wallet));
    });
    return untold ? UNTOLD_IN_PLACE : TOLD;
  }

  /**
   * A local-mode sign-out on a product, where the sign-out window tells the phone, so the page waits until the window
   * has read the paired session, then leaves local mode.
   */
  async function signOutLocal(wallet: Promise<WalletRead>): Promise<LogoutOutcome> {
    // A sign-out ends the paired session too. A local wallet core cannot tell the phone, so the sign-out window does,
    // having read the session from the main store, which in a browser that shares the store is this page's copy. A
    // flag that reads gone has the restore rule clear the copy on the reload, and one set again covers a new sign-in.
    // Only an unreadable flag leaves the copy to this page. Its own clear is not the flag's, since the flag is unknown.
    if ((await deps.presence.read()) === 'unknown') {
      await dropPairedCopy();
    }
    // Before the switch, which reloads the page.
    await forgetGrants();
    // A local session lives only in memory, so signing out means leaving local mode. Either outcome ends the sign-out
    // here: the page reloads, or the switch already reported why it stayed.
    await deps.leaveLocalWallet(async () => {
      await forgetWalletRead(wallet);
    });
    return TOLD;
  }

  return {
    signOut() {
      log.event('logout requested', { flow: 'wallet' });
      if (deps.walletMode() !== 'local') {
        // Before any wait, so the read is ahead of the window's restore rule and of a visible check.
        const held = deps.copy.readSession();
        return deps.signOuts.call(() => deps.onCore(() => signOutPaired(held)));
      }
      // Before any wait, so it is the wallet the user signed out of.
      const wallet = readWallet();
      const signOutWindow = deps.signOutWindow();
      if (signOutWindow === null) {
        return deps.signOuts.call(() => deps.onCore(() => signOutLocalInPlace(wallet)));
      }
      // Before the queue, so the sign-out waits on the window open when it was asked and not on one a later click
      // opens.
      const windowRead = signOutWindow.signOutRead();
      return deps.signOuts.call(async () => {
        deps.reportSigningOut(true);
        try {
          await windowRead;
        } finally {
          deps.reportSigningOut(false);
        }
        return deps.onCore(() => signOutLocal(wallet));
      });
    },
    async signOutLocally() {
      if (deps.walletMode() === 'local') {
        // The watch found the wallet gone, so nothing is forgotten here, and a wallet saved since stays. A failed
        // switch was reported there and left the page as it was.
        if ((await deps.leaveLocalWallet(NOTHING_TO_FORGET)) === 'failed') {
          throw new Error('The local wallet could not be forgotten');
        }
        return;
      }
      // Only a core already running holds the session, so none is booted just to drop it.
      await deps.cores.resetSession();
      deps.session.reportSignedOut();
    },
  };
}
