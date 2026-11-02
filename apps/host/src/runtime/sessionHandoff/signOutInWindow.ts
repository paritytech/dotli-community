// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-out window does. The page that opened it deleted the signed-in flag first, so the paired session the
// main store still holds is dead, while a local wallet stays for that page to forget. The window applies the restore
// rule to the main store, which clears only what it read while the flag is still gone, so a sign-in made elsewhere
// since stays. It tells the page it has read, then ends the session the rule found dead on a core of its own when the
// page could not tell the phone. Its sign-out never waits on the opener: the read goes out once the opener is vetted,
// and a window that closes before then drops it. Only dot.li's own page ends the sites signed in through the session
// window, so unless it kept the sign-in, the window forgets them once its first vetting found that page, and an
// opener that never says hello keeps it open until then. The core sends the phone its message in a task of its own
// after its disconnect answers, so a window that told the phone stays open, saying the user is signed out, and the user
// closes it. Any other window closes itself.

import { m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { Reconciled } from '../session/restoreRule.js';
import { reportWalletFailure } from '../walletFailure.js';

export type WindowSignOutParams = {
  /** Whether the page told the phone itself, as the window's request says. */
  notified: boolean;
  /**
   * The restore rule on the main store, run once for the window. Its answer holds the dead session even once the store
   * lost it, whoever ran it first. Never rejects.
   */
  restore: () => Promise<Reconciled>;
  /**
   * Ends `blob` on the window's own core, which tells the phone. The core holds it in memory, so a page that clears the
   * store meanwhile takes nothing from it. Rejects when the session could not be ended.
   */
  endSession: (blob: string) => Promise<void>;
  /**
   * Tells the page that opened the window it has read what it ends, so the page may clear its own copy, now or once
   * the page is vetted. Never throws.
   */
  read: () => void;
  /**
   * Whether the round's first vetting found dot.li's own page with a round the window answers, false for a site, a
   * refused round or a window with no opener. Never rejects.
   */
  firstParty: Promise<boolean>;
  /**
   * Forgets every site signed in through the session window, as a sign-out ends their sign-ins too. Rejects when the
   * sites could not be forgotten.
   */
  forgetGrants: () => Promise<void>;
  /** Closes the window. */
  close: () => void;
  /** Says the user is signed out, with Close, in place of closing, once the window told the phone. */
  showSignedOut: () => void;
};

/**
 * How the window's sign-out ended, a closed set so the metric's `outcome` tag stays bounded. `kept` is a flag still set
 * or unreadable, or set again before the window cleared, `error` a step that failed while the window still cleared
 * what it could.
 */
export type WindowSignOutOutcome = 'told_phone' | 'cleared' | 'nothing' | 'kept' | 'error';

/** How the window's sign-out ended, and whether it told the phone, whose message may still be on its way. */
type Ended = {
  outcome: WindowSignOutOutcome;
  told: boolean;
};

/**
 * Signs out what the main store holds and counts how it ended. A window that told the phone then says the user is
 * signed out and waits for Close, and any other closes itself, whatever happened. Never rejects, since every step it
 * waits on either never rejects or is reported here.
 */
export async function signOutInWindow(params: WindowSignOutParams): Promise<WindowSignOutOutcome> {
  let told = false;
  try {
    const ended = await signOut(params);
    told = ended.told;
    // A flag still set or unreadable keeps the sign-in, and the sites signed in with it. A site that opened the window
    // ends none of them.
    if (ended.outcome !== 'kept' && (await params.firstParty)) {
      await forgetSiteGrants(params);
    }
    log.event('sign-out window done', { flow: 'wallet', outcome: ended.outcome });
    m.count(S.SESSION_WINDOW_SIGNOUT_RESULT, {
      outcome: ended.outcome,
      reason: params.notified ? 'notified' : 'unnotified',
    });
    return ended.outcome;
  } finally {
    if (told) {
      params.showSignedOut();
    } else {
      params.close();
    }
  }
}

async function signOut(params: WindowSignOutParams): Promise<Ended> {
  const restored = await params.restore();
  params.read();
  // A flag still set means no page signed out, since a page may open this window by a plain link. One that cannot be
  // read keeps the store, since a sign-in it cannot rule out may still be in use.
  if (restored.presence !== 'absent') {
    return { outcome: 'kept', told: false };
  }
  const phone = await tellPhone(params, restored.dead?.blob ?? null);
  const told = phone === 'told';
  // The boot reported a session read that failed. The wallet is the page's to forget, so its read is not the window's.
  if (phone === 'failed' || restored.session.status === 'failed' || restored.dead?.cleared === 'failed') {
    return { outcome: 'error', told };
  }
  if (told) {
    return { outcome: 'told_phone', told };
  }
  return { outcome: restored.dead?.cleared === 'dropped' ? 'cleared' : 'nothing', told };
}

/** Ends the dead session when the page could not tell the phone. Never rejects. */
async function tellPhone(
  { notified, endSession }: Pick<WindowSignOutParams, 'notified' | 'endSession'>,
  dead: string | null,
): Promise<'told' | 'skipped' | 'failed'> {
  if (dead === null || notified) {
    return 'skipped';
  }
  try {
    await endSession(dead);
    return 'told';
  } catch (error) {
    // The phone keeps this device listed until the user removes it there.
    // Counted with how the window ended.
    reportWalletFailure(error, { what: 'sign-out window end', step: 'session_window_signout', reason: 'end' });
    return 'failed';
  }
}

/** Forgets the grants. Never rejects, as a sign-out goes on whether or not they went. */
async function forgetSiteGrants({ forgetGrants }: Pick<WindowSignOutParams, 'forgetGrants'>): Promise<void> {
  try {
    await forgetGrants();
  } catch (error) {
    // The sites keep their tokens until the user revokes them. Counted apart from how the sign-out ended, which this
    // leaves unchanged.
    reportWalletFailure(error, { what: 'sign-out window grants', step: 'session_window_signout', reason: 'grants' });
    m.count(S.SITE_REVOKE, { outcome: 'error', reason: 'sign_out' });
  }
}
