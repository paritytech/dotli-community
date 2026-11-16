// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's restore on load. It applies the restore rule to the page's copy, and the wallet the rule leaves is the
// page's wallet mode.

import { createReporter, defineCount } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createAsyncTaskPool } from '@dotli/shared';
import { reportLocalWalletFailure, walletLocalActivateMetric } from './walletFailure.js';
import { getLoadReader, isPairingOnly, isFlagShared, type PageRole } from './pageRole.js';
import type { PresenceReader, Reconciled } from './restoreRule.js';
import { sessionPresenceMetric } from './sessionPresenceMetric.js';
import type { WalletRead } from './siteWallet.js';
import type { SignInFlag } from './signInFlag.js';
import type { WalletModeState } from './walletModeState.js';

const walletReport = createReporter({ flow: 'wallet' });

/** A restore rule that rejected. Tagged `outcome` (error). */
const walletBootTransitionMetric = defineCount<'error'>('wallet_boot.transition');

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

type NoteKeptParams = Pick<Reconciled, 'presence'> & {
  session: Extract<Reconciled['session'], { status: 'ok' }>;
  wallet: AnsweredWallet;
};

const UNREADABLE = 'Local wallet could not be decrypted and was forgotten';

/** Builds the restore on load. */
export function createWalletBoot({ reconcile, report, flag, role }: Params) {
  const reader: PresenceReader = getLoadReader(role);
  // One pass at a time, so a caller that asks during a pass waits for it, and takes its answer once it is kept.
  const passes = createAsyncTaskPool({ poolSize: 1 });
  // Whether a stored wallet picks the mode, which a page that only pairs keeps as data until it serves a site.
  let bootsOnStored = !isPairingOnly(role);
  // The first wallet the frame answered, which set the mode, so a later pass only reconciles the session.
  let wallet: AnsweredWallet | null = null;
  // The first dead session a pass found, since a later pass finds the store already empty.
  let dead: Reconciled['dead'] = null;
  // What the rule left for the page, once a pass kept it.
  let kept: Reconciled | null = null;

  const walletBoot = {
    /**
     * What the restore rule left of the stored sign-in. Kept for the page once the frame answered both the session and
     * the wallet read, so the rule runs before boot picks a wallet mode and before any core or session state reads the
     * session. A read it could not answer was not reconciled, so the next caller applies the rule again. The first
     * wallet answered keeps the mode, and the first dead session found stays in the answer. A caller that asks during
     * a pass waits for it, and takes its answer once it is kept. Rejects only when the restore rule breaks its contract
     * and rejects, with that rejection as the cause.
     */
    async restore(): Promise<Restored> {
      const reconciled = await passes.call(pass);
      // Worked out on each answer, since a window that serves a site from then on boots on the stored wallet.
      return { ...reconciled, local: getLocalWallet(reconciled.wallet, bootsOnStored) };
    },
    /**
     * Null boots the pairing host. A failed read cannot tell the mode, so it falls back to Polkadot App. On a page that
     * only pairs, the sign-in and sign-out windows, a stored wallet never picks the mode, except in a sign-in window
     * that serves a site, which boots on a stored local wallet. Rejects only when the restore rule breaks its contract
     * and rejects, with that rejection as the cause.
     */
    async read(): Promise<LocalWalletBoot | null> {
      return (await walletBoot.restore()).local;
    },
    /**
     * The sign-in window serves a site from here on, so a stored local wallet picks the mode and the wallet mode is
     * reported again. Called before anything boots a core, as a core already booted keeps the mode it read.
     */
    serveSites(): void {
      bootsOnStored = true;
      if (wallet !== null) {
        report(getWalletMode(wallet, true));
      }
    },
  };
  return walletBoot;

  /**
   * Answers with the kept answer, or applies the restore rule over what the passes so far found and keeps what it left
   * once the frame answered both reads. Rejects when the restore rule rejects, with that rejection as the cause.
   */
  async function pass(): Promise<Reconciled> {
    if (kept !== null) {
      return kept;
    }
    let reconciled: Reconciled;
    try {
      reconciled = await reconcile(reader);
    } catch (error) {
      walletReport.defect(error, {
        step: 'restore',
        metric: walletBootTransitionMetric,
        message: '[dot.li wallet] the restore rule rejected:',
      });
      throw new Error('The restore rule failed', { cause: error });
    }
    // Until a wallet read is answered, each pass reports the mode it found.
    const walletAnswered = wallet !== null;
    const passWallet = wallet ?? reconciled.wallet;
    const { presence, session } = reconciled;
    // A read the frame could not answer leaves nothing kept for the page.
    const isKept = passWallet.status !== 'failed' && session.status !== 'failed';
    dead ??= reconciled.dead;
    const restored: Reconciled = { ...reconciled, wallet: passWallet, dead };

    // What the pass found is written before anything is reported, so a listener that calls back in sees it whole.
    if (passWallet.status !== 'failed') {
      wallet = passWallet;
    }
    if (isKept) {
      kept = restored;
    }

    if (!walletAnswered) {
      reportMode(passWallet);
    }
    if (isKept) {
      noteKept({ presence, session, wallet: passWallet });
    }
    return restored;
  }

  /** Reports the mode `passWallet` tells, with why a wallet that could not be read or decrypted is not used. */
  function reportMode(passWallet: WalletRead): void {
    switch (passWallet.status) {
      case 'failed':
        // The environment's failure, so each pass that met it is a breadcrumb and a count.
        walletReport.expected(passWallet.error, {
          step: 'local_wallet',
          metric: walletLocalActivateMetric,
          reason: 'read',
        });
        break;
      case 'unreadable':
        reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
        break;
      case 'none':
      case 'ok':
        break;
    }
    // It tells the mode even when a read failed, so cores can boot, and core storage reports a failed session.
    report(getWalletMode(passWallet, bootsOnStored));
  }

  /** Logs what a kept answer leaves the page without, and renews the flag on a sign-in it found. */
  function noteKept({ presence, session, wallet: keptWallet }: NoteKeptParams): void {
    if (presence === 'unknown' && isFlagShared(role)) {
      walletReport.log.event('signed-in flag unreadable, keeping the stored sign-in');
      sessionPresenceMetric.count({ outcome: 'unreadable', reason: reader });
    }
    if (keptWallet.status === 'ok' && !bootsOnStored) {
      walletReport.log.event('local wallet kept as data, page pairs');
    }
    // Renewed rather than set, since a sign-out elsewhere may have deleted it since the read.
    if (presence === 'present' && (session.blob !== null || keptWallet.status === 'ok')) {
      flag.renew();
    }
  }
}

/** The stored wallet the page boots on, or null when there is none or the page keeps it as data. */
function getLocalWallet(wallet: WalletRead, bootsOnStored: boolean): LocalWalletBoot | null {
  return wallet.status === 'ok' && bootsOnStored ? wallet : null;
}

/** The mode `wallet` picks, with why a wallet that could not be read or no longer decrypts is not used. */
function getWalletMode(wallet: WalletRead, bootsOnStored: boolean): WalletModeState {
  if (wallet.status === 'failed') {
    return { mode: 'app', failure: 'Local wallet could not be read, so this page uses Polkadot App' };
  }
  return {
    mode: getLocalWallet(wallet, bootsOnStored) === null ? 'app' : 'local',
    failure: wallet.status === 'unreadable' ? UNREADABLE : null,
  };
}
