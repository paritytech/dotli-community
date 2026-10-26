// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's restore on load. It applies the restore rule to the page's copy, and the wallet the rule leaves is the
// page's wallet mode.

import { m, reportExpected, spans as S } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createAsyncTaskPool, log } from '@dotli/shared';
import { reportLocalWalletFailure } from './wallet-failure.js';
import { loadReader, pageRole, pairsOnly, sharesFlag, type PageRole } from './page-role.js';
import { signInFlag } from './session/core-storage.js';
import { reconcilePage, type PresenceReader, type Reconciled } from './session/restore-rule.js';
import type { WalletRead } from './session/site-wallet.js';
import type { SignInFlag } from './session/sign-in-flag.js';
import { setWalletModeState, type WalletModeState } from './state/wallet-mode.js';

export type LocalWalletBoot = Extract<LocalWalletReadResult, { status: 'ok' }>;

const UNREADABLE = 'Local wallet could not be decrypted and was forgotten';
const UNAVAILABLE = 'Local wallet could not be read, so this page uses Polkadot App';

export interface WalletBootDeps {
  /** The restore rule over the page's copy, counted under `reader`. Never rejects. */
  reconcile: (reader: PresenceReader) => Promise<Reconciled>;
  /** Where the page's wallet mode goes once the restore settles it. */
  report: (state: WalletModeState) => void;
  /** Renews the flag on each sign-in the load finds, so it lives as long as the user keeps using dotli. */
  flag: Pick<SignInFlag, 'renew'>;
  /**
   * Whether a stored wallet picks the mode, under which reader the rule counts, and whether a flag that reads unknown
   * is a miss to count or the role's design.
   */
  role: PageRole;
}

/** What the restore rule left, with the wallet the page boots on: none on a page that only pairs. */
export interface Restored extends Reconciled {
  local: LocalWalletBoot | null;
}

export interface WalletBoot {
  /**
   * What the restore rule left of the stored sign-in. Kept for the page once the frame answered both the session and
   * the wallet read, so the rule runs before boot picks a wallet mode and before any core or session state reads the
   * session. A read it could not answer was not reconciled, so the next caller applies the rule again. The first wallet
   * answered keeps the mode, and the first dead session found stays in the answer.
   */
  restore(): Promise<Restored>;
  /**
   * Null boots the pairing host. A failed read cannot tell the mode, so it falls back to Polkadot App. On a page that
   * only pairs, the sign-in and sign-out windows, a stored wallet never picks the mode.
   */
  read(): Promise<LocalWalletBoot | null>;
}

export function createWalletBoot(deps: WalletBootDeps): WalletBoot {
  const { report, role } = deps;
  const pairingOnly = pairsOnly(role);
  const reader: PresenceReader = loadReader(role);
  // One restore at a time, so a caller that queued behind an answered one takes its answer.
  const restores = createAsyncTaskPool({ poolSize: 1 });
  let answer: Restored | undefined;
  // The first wallet the frame answered, which set the mode. A later pass only reconciles the session.
  let walletAnswer: Exclude<WalletRead, { status: 'failed' }> | undefined;
  // The first dead session a pass found, kept until a pass is kept, since a later pass finds the store already empty.
  let dead: Reconciled['dead'] = null;

  const localOf = (wallet: WalletRead): LocalWalletBoot | null =>
    wallet.status === 'ok' && !pairingOnly ? wallet : null;

  /** A frame that cannot answer is the environment's failure, so each pass that met it is a breadcrumb and a count. */
  const reportOutage = (error: unknown): void => {
    reportExpected(error, { flow: 'wallet', step: 'local_wallet', metric: S.WALLET_LOCAL_ACTIVATE, reason: 'read' });
    report({ mode: 'app', failure: UNAVAILABLE });
  };

  /** Reports the mode the first wallet the frame answered picks, once. */
  const reportMode = (wallet: Exclude<WalletRead, { status: 'failed' }>): void => {
    if (wallet.status === 'unreadable') {
      reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
    }
    report({
      mode: localOf(wallet) === null ? 'app' : 'local',
      failure: wallet.status === 'unreadable' ? UNREADABLE : null,
    });
  };

  /**
   * Counts a flag that could not be read and renews the flag for a sign-in the page keeps. Once per page, since
   * the answer is kept from here.
   */
  const settle = ({ presence, session, wallet }: Restored): void => {
    if (presence === 'unknown' && sharesFlag(role)) {
      log.event('signed-in flag unreadable, keeping the stored sign-in', { flow: 'wallet' });
      m.count(S.SESSION_PRESENCE, { outcome: 'unreadable', reason: reader });
    }
    // Renewed rather than set, since a sign-out elsewhere may have deleted it since the read.
    const signedIn = (session.status === 'ok' && session.blob !== null) || wallet.status === 'ok';
    if (presence === 'present' && signedIn) {
      deps.flag.renew();
    }
    if (wallet.status === 'ok' && pairingOnly) {
      log.event('local wallet kept as data, page pairs', { flow: 'wallet' });
    }
  };

  const restoreOnce = async (): Promise<Restored> => {
    if (answer !== undefined) {
      return answer;
    }
    const reconciled = await deps.reconcile(reader);
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
    const restored: Restored = { ...reconciled, wallet, dead, local: localOf(wallet) };
    if (walletAnswer !== undefined && restored.session.status !== 'failed') {
      answer = restored;
      settle(restored);
    }
    return restored;
  };

  const restore = (): Promise<Restored> => restores.call(restoreOnce);

  return {
    restore,
    read: async () => (await restore()).local,
  };
}

let pageWalletBoot: WalletBoot | undefined;

/**
 * The page's one wallet boot, shared by every core, by session state and by the windows. Built on first use, which
 * comes after the page's boot chose its role.
 */
function pageBoot(): WalletBoot {
  pageWalletBoot ??= createWalletBoot({
    reconcile: reconcilePage,
    report: setWalletModeState,
    flag: signInFlag,
    role: pageRole(),
  });
  return pageWalletBoot;
}

export async function readWalletBoot(): Promise<LocalWalletBoot | null> {
  return pageBoot().read();
}

/** Settles once the restore rule ran on the page's copy, with what it left. */
export async function restoreOnBoot(): Promise<Restored> {
  return pageBoot().restore();
}
