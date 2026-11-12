// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's restore on load. It applies the restore rule to the page's copy, and the wallet the rule leaves is the
// page's wallet mode.

import { createReporter, defineCount } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createAsyncTaskPool, createStateMachine, type HandlerOf, type MachineTypes } from '@dotli/shared';
import { reportLocalWalletFailure, walletLocalActivateMetric } from './walletFailure.js';
import { getLoadReader, pageRole, isPairingOnly, isFlagShared, type PageRole } from './pageRole.js';
import { signInFlag } from './session/createCoreStorage.js';
import { reconcilePage, type PresenceReader, type Reconciled } from './session/restoreRule.js';
import { sessionPresenceMetric } from './session/sessionPresenceMetric.js';
import type { WalletRead } from './session/siteWallet.js';
import type { SignInFlag } from './session/signInFlag.js';
import { walletModeState, type WalletModeState } from './state/walletModeState.js';

const walletReport = createReporter({ flow: 'wallet' });

/** A wallet boot's transition or effect that threw, or a restore rule that rejected. Tagged `outcome` (error). */
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

/**
 * `walletUnread` and `walletRead` hold the first dead session a pass found, since a later pass finds the store already
 * empty, and `last`, what the last pass left. `walletRead` holds the first wallet the frame answered, which set the mode,
 * so a later pass only reconciles the session. `kept` is the answer for the page. `passFailed` holds the state the
 * broken pass left, which the next pass starts from.
 */
type BootState =
  | { kind: 'unread' }
  | { kind: 'walletUnread'; dead: Reconciled['dead']; last: Restored }
  | { kind: 'walletRead'; wallet: AnsweredWallet; dead: Reconciled['dead']; last: Restored }
  | { kind: 'kept'; wallet: AnsweredWallet; answer: Restored }
  | { kind: 'passFailed'; previous: Exclude<BootState, { kind: 'kept' | 'passFailed' }>; error: unknown };

type BootEvent =
  | { kind: 'asked' }
  | { kind: 'passed'; reconciled: Reconciled }
  | { kind: 'passBroke'; error: unknown }
  | { kind: 'sitesServed' };

type BootEffect =
  | { kind: 'walletUnavailable'; error: unknown }
  | { kind: 'modeChosen'; wallet: AnsweredWallet }
  | { kind: 'modeReported'; wallet: AnsweredWallet }
  | { kind: 'restoreKept'; restored: Restored };

type BootMachine = MachineTypes<BootState, BootEvent, BootEffect>;

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

  const startPass: HandlerOf<BootMachine, 'unread' | 'walletUnread' | 'walletRead' | 'passFailed', 'asked'> = (
    state,
    _event,
    { emitState, update },
  ) => {
    if (state.kind === 'passFailed') {
      emitState(state.previous);
    }
    update(
      // Started in the chain, so a rule that throws before it returns a promise breaks the pass like a rejection.
      Promise.resolve(reader)
        .then(reconcile)
        .then(
          reconciled => ({ kind: 'passed', reconciled }),
          (error: unknown) => {
            walletReport.defect(error, {
              step: 'restore',
              metric: walletBootTransitionMetric,
              message: '[dot.li wallet] the restore rule rejected:',
            });
            return { kind: 'passBroke', error };
          },
        ),
    );
  };
  const applyPass: HandlerOf<BootMachine, 'unread' | 'walletUnread' | 'walletRead', 'passed'> = (
    state,
    { reconciled },
    { emitState, emitSideEffect },
  ) => {
    const dead = (state.kind === 'unread' ? null : state.dead) ?? reconciled.dead;
    const wallet = state.kind === 'walletRead' ? state.wallet : reconciled.wallet;
    const last: Restored = { ...reconciled, wallet, dead, local: getLocalWallet(wallet) };
    if (wallet.status === 'failed') {
      emitState({ kind: 'walletUnread', dead, last });
      emitSideEffect({ kind: 'walletUnavailable', error: wallet.error });
      return;
    }
    if (state.kind !== 'walletRead') {
      // It tells the mode even when the session read failed, so cores can boot, and core storage reports that.
      emitSideEffect({ kind: 'modeChosen', wallet });
    }
    const { presence, session } = reconciled;
    if (session.status === 'failed') {
      emitState({ kind: 'walletRead', wallet, dead, last });
      return;
    }
    emitState({ kind: 'kept', wallet, answer: last });
    emitSideEffect({ kind: 'restoreKept', restored: last });
    // Renewed rather than set, since a sign-out elsewhere may have deleted it since the read.
    if (presence === 'present' && (session.blob !== null || wallet.status === 'ok')) {
      flag.renew();
    }
  };
  // The pass's work reported the rejection.
  const failPass: HandlerOf<BootMachine, 'unread' | 'walletUnread' | 'walletRead', 'passBroke'> = (
    state,
    { error },
    { emitState },
  ) => {
    emitState({ kind: 'passFailed', previous: state, error });
  };
  // Reported once already, so only the mode goes out again.
  const reportServedMode: HandlerOf<BootMachine, 'walletRead' | 'kept', 'sitesServed'> = (
    { wallet },
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'modeReported', wallet });
  };
  const machine = createStateMachine<BootMachine>({
    initial: { kind: 'unread' },
    handlers: {
      unread: { asked: startPass, passed: applyPass, passBroke: failPass },
      walletUnread: { asked: startPass, passed: applyPass, passBroke: failPass },
      walletRead: { asked: startPass, passed: applyPass, passBroke: failPass, sitesServed: reportServedMode },
      kept: { sitesServed: reportServedMode },
      passFailed: {
        asked: startPass,
        sitesServed({ previous }, _event, { emitSideEffect }) {
          if (previous.kind === 'walletRead') {
            emitSideEffect({ kind: 'modeReported', wallet: previous.wallet });
          }
        },
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'walletUnavailable':
          // The environment's failure, so each pass that met it is a breadcrumb and a count.
          walletReport.expected(effect.error, {
            step: 'local_wallet',
            metric: walletLocalActivateMetric,
            reason: 'read',
          });
          report({ mode: 'app', failure: UNAVAILABLE });
          return;
        case 'modeChosen':
          if (effect.wallet.status === 'unreadable') {
            reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
          }
          report(getWalletMode(effect.wallet));
          return;
        case 'modeReported':
          report(getWalletMode(effect.wallet));
          return;
        case 'restoreKept': {
          const { presence, wallet, local } = effect.restored;
          if (presence === 'unknown' && isFlagShared(role)) {
            walletReport.log.event('signed-in flag unreadable, keeping the stored sign-in');
            sessionPresenceMetric.count({ outcome: 'unreadable', reason: reader });
          }
          if (wallet.status === 'ok' && local === null) {
            walletReport.log.event('local wallet kept as data, page pairs');
          }
          return;
        }
      }
    },
    onError(error) {
      walletReport.defect(error, {
        step: 'transition',
        metric: walletBootTransitionMetric,
        message: '[dot.li wallet] A wallet boot transition threw',
      });
    },
  });

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

  function restore(): Promise<Restored> {
    return restores.call(async () => {
      machine.update({ kind: 'asked' });
      await machine.await();
      const settled = machine.state.get();
      switch (settled.kind) {
        case 'kept':
          return settled.answer;
        case 'walletUnread':
        case 'walletRead':
          return settled.last;
        case 'passFailed':
          throw new Error('The restore rule failed', { cause: settled.error });
        // A pass always leaves it.
        case 'unread':
          throw new Error('The wallet boot has no pass of its own');
      }
    });
  }

  // By the rule that holds now, as the restore keeps its first answer for the saved copy.
  async function read(): Promise<LocalWalletBoot | null> {
    return getLocalWallet((await restore()).wallet);
  }

  function serveSites(): void {
    servesSites = true;
    machine.update({ kind: 'sitesServed' });
  }

  return {
    /**
     * What the restore rule left of the stored sign-in. Kept for the page once the frame answered both the session and
     * the wallet read, so the rule runs before boot picks a wallet mode and before any core or session state reads the
     * session. A read it could not answer was not reconciled, so the next caller applies the rule again. The first
     * wallet answered keeps the mode, and the first dead session found stays in the answer. Rejects only when the
     * restore rule breaks its contract and rejects, with that rejection as the cause.
     */
    restore,
    /**
     * Null boots the pairing host. A failed read cannot tell the mode, so it falls back to Polkadot App. On a page that
     * only pairs, the sign-in and sign-out windows, a stored wallet never picks the mode, except in a sign-in window
     * that serves a site, which boots on a stored local wallet. Rejects only when the restore rule breaks its contract
     * and rejects, with that rejection as the cause.
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
    /**
     * The local wallet the page boots on, or null to boot the pairing host. Rejects before the role is chosen, and when
     * the restore rule breaks its contract and rejects.
     */
    read,
    /**
     * The sign-in window serves a site, so its cores boot on a stored local wallet. Throws only before the role is
     * chosen.
     */
    serveSites,
    /**
     * Settles once the restore rule ran on the page's copy, with what it left. Rejects before the role is chosen, and
     * when the restore rule breaks its contract and rejects.
     */
    restore,
  };
}

/** The page's one wallet boot. */
export const pageWalletBoot = createPageWalletBoot();
