// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's restore on load. It applies the restore rule to the page's copy, and the wallet the rule leaves is the
// page's wallet mode.

import { createReporter } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createAsyncTaskPool } from '@dotli/shared';
import { reportLocalWalletFailure, walletLocalActivateMetric } from './walletFailure.js';
import { getLoadReader, pageRole, isPairingOnly, isFlagShared, type PageRole } from './pageRole.js';
import { signInFlag } from './session/createCoreStorage.js';
import { reconcilePage, type PresenceReader, type Reconciled } from './session/restoreRule.js';
import { sessionPresenceMetric } from './session/sessionPresenceMetric.js';
import type { WalletRead } from './session/siteWallet.js';
import type { SignInFlag } from './session/signInFlag.js';
import { walletModeState, type WalletModeState } from './state/walletModeState.js';

const walletReport = createReporter({ flow: 'wallet' });

export type LocalWalletBoot = Extract<LocalWalletReadResult, { status: 'ok' }>;

type Params = {
  /** The restore rule over the page's copy, counted under `reader`. Never rejects. */
  reconcile: (reader: PresenceReader) => Promise<Reconciled>;
  /** Where the page's wallet mode goes once the restore settles it. Must not throw. */
  report: (state: WalletModeState) => void;
  /** Renews the flag on each sign-in the load finds, so it lives as long as the user keeps using dotli. */
  flag: Pick<SignInFlag, 'renew'>;
  /**
   * Whether a stored wallet picks the mode, under which reader the rule counts, and whether a flag that reads unknown
   * is a miss to count or the role's design.
   */
  role: PageRole;
};

/** What the restore rule left, with the wallet the page boots on: none on a page that only pairs. */
export type Restored = {
  local: LocalWalletBoot | null;
} & Reconciled;

export type WalletBoot = ReturnType<typeof createWalletBoot>;

/** A wallet read the frame answered, whatever it found. */
type AnsweredWallet = Exclude<WalletRead, { status: 'failed' }>;

const UNREADABLE = 'Local wallet could not be decrypted and was forgotten';
const UNAVAILABLE = 'Local wallet could not be read, so this page uses Polkadot App';

/** Builds the restore on load. Building it never throws. */
export function createWalletBoot({ reconcile, report, flag, role }: Params) {
  const pairingOnly = isPairingOnly(role);
  // A window that serves a site boots on the stored wallet, which it otherwise keeps as data.
  let servesSites = false;
  const reader: PresenceReader = getLoadReader(role);
  // One restore at a time, so a caller that queued behind an answered one takes its answer.
  const restores = createAsyncTaskPool({ poolSize: 1 });
  let answer: Restored | undefined;
  // The first wallet the frame answered, which set the mode. A later pass only reconciles the session.
  let walletAnswer: AnsweredWallet | undefined;
  // The first dead session a pass found, kept until a pass is kept, since a later pass finds the store already empty.
  let dead: Reconciled['dead'] = null;

  /** The stored wallet the page boots on, or null when there is none or the page keeps it as data. */
  function getLocalWallet(wallet: WalletRead): LocalWalletBoot | null {
    return wallet.status === 'ok' && (!pairingOnly || servesSites) ? wallet : null;
  }

  /** The mode `wallet` picks, with why a wallet that no longer decrypts was forgotten. */
  function getWalletMode(wallet: AnsweredWallet): WalletModeState {
    return {
      mode: getLocalWallet(wallet) === null ? 'app' : 'local',
      failure: getWalletFailure(wallet),
    };
  }

  /** A frame that cannot answer is the environment's failure, so each pass that met it is a breadcrumb and a count. */
  function reportOutage(error: unknown): void {
    walletReport.expected(error, { step: 'local_wallet', metric: walletLocalActivateMetric, reason: 'read' });
    report({ mode: 'app', failure: UNAVAILABLE });
  }

  /** Reports the mode the first wallet the frame answered picks, once. */
  function reportMode(wallet: AnsweredWallet): void {
    if (wallet.status === 'unreadable') {
      reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
    }
    report(getWalletMode(wallet));
  }

  /**
   * Counts a flag that could not be read and renews the flag for a sign-in the page keeps. Once per page, since
   * the answer is kept from here.
   */
  function settle({ presence, session, wallet }: Restored): void {
    if (presence === 'unknown' && isFlagShared(role)) {
      walletReport.log.event('signed-in flag unreadable, keeping the stored sign-in');
      sessionPresenceMetric.count({ outcome: 'unreadable', reason: reader });
    }
    // Renewed rather than set, since a sign-out elsewhere may have deleted it since the read.
    const signedIn = (session.status === 'ok' && session.blob !== null) || wallet.status === 'ok';
    if (presence === 'present' && signedIn) {
      flag.renew();
    }
    if (wallet.status === 'ok' && getLocalWallet(wallet) === null) {
      walletReport.log.event('local wallet kept as data, page pairs');
    }
  }

  async function restoreOnce(): Promise<Restored> {
    if (answer !== undefined) {
      return answer;
    }
    const reconciled = await reconcile(reader);
    if (walletAnswer === undefined) {
      if (reconciled.wallet.status === 'failed') {
        reportOutage(reconciled.wallet.error);
      } else {
        // It tells the mode even when the session read failed, so cores can boot, and core storage reports that.
        walletAnswer = reconciled.wallet;
        reportMode(walletAnswer);
      }
    }
    dead ??= reconciled.dead;
    const wallet = walletAnswer ?? reconciled.wallet;
    const restored: Restored = { ...reconciled, wallet, dead, local: getLocalWallet(wallet) };
    if (walletAnswer !== undefined && restored.session.status !== 'failed') {
      answer = restored;
      settle(restored);
    }
    return restored;
  }

  function restore(): Promise<Restored> {
    return restores.call(restoreOnce);
  }

  // By the rule that holds now, as the restore keeps its first answer for the saved copy.
  async function read(): Promise<LocalWalletBoot | null> {
    return getLocalWallet((await restore()).wallet);
  }

  function serveSites(): void {
    servesSites = true;
    // Reported once already, so only the mode goes out again.
    if (walletAnswer !== undefined) {
      report(getWalletMode(walletAnswer));
    }
  }

  return {
    /**
     * What the restore rule left of the stored sign-in. Kept for the page once the frame answered both the session and
     * the wallet read, so the rule runs before boot picks a wallet mode and before any core or session state reads the
     * session. A read it could not answer was not reconciled, so the next caller applies the rule again. The first
     * wallet answered keeps the mode, and the first dead session found stays in the answer. Never rejects.
     */
    restore,
    /**
     * Null boots the pairing host. A failed read cannot tell the mode, so it falls back to Polkadot App. On a page that
     * only pairs, the sign-in and sign-out windows, a stored wallet never picks the mode, except in a sign-in window
     * that serves a site, which boots on a stored local wallet. Never rejects.
     */
    read,
    /**
     * The sign-in window serves a site from here on, so a stored local wallet picks the mode and the wallet mode is
     * reported again. Called before anything boots a core, as a core already booted keeps the mode it read. Never
     * throws.
     */
    serveSites,
  };
}

/** Why the wallet `wallet` found was forgotten, or null when it was not. */
function getWalletFailure(wallet: AnsweredWallet): string | null {
  switch (wallet.status) {
    case 'unreadable':
      return UNREADABLE;
    case 'ok':
    case 'none':
      return null;
  }
}

/**
 * Builds the slot of the page's one wallet boot, which builds the boot on first use, after the page's boot chose its
 * role. Never throws, and each member throws or rejects when used before the page's boot chose its role.
 */
function createPageWalletBoot() {
  let boot: WalletBoot | undefined;

  function getBoot(): WalletBoot {
    boot ??= createWalletBoot({
      reconcile: reconcilePage,
      report: walletModeState.set,
      flag: signInFlag,
      role: pageRole.get(),
    });
    return boot;
  }

  async function read(): Promise<LocalWalletBoot | null> {
    return getBoot().read();
  }

  function serveSites(): void {
    getBoot().serveSites();
  }

  async function restore(): Promise<Restored> {
    return getBoot().restore();
  }

  return {
    /** The local wallet the page boots on, or null to boot the pairing host. Rejects only before the role is chosen. */
    read,
    /**
     * The sign-in window serves a site, so its cores boot on a stored local wallet. Throws only before the role is
     * chosen.
     */
    serveSites,
    /**
     * Settles once the restore rule ran on the page's copy, with what it left. Rejects only before the role is
     * chosen.
     */
    restore,
  };
}

/** The page's one wallet boot. */
export const pageWalletBoot = createPageWalletBoot();
