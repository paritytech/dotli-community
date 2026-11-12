// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's restore on load. It applies the restore rule to the page's copy, and the wallet the rule leaves is the
// page's wallet mode.

import { createReporter, defineCount } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createStateMachine, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
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

/** A `restore` or a `read` waiting for its answer. */
type Caller =
  | { kind: 'restore'; resolve: (restored: Restored) => void; reject: (error: unknown) => void }
  | { kind: 'read'; resolve: (local: LocalWalletBoot | null) => void; reject: (error: unknown) => void };

/**
 * What the passes so far found, short of an answer to keep. `walletUnread` and `walletRead` hold the first dead
 * session a pass found, since a later pass finds the store already empty, and `last`, what the last pass left.
 * `walletRead` holds the first wallet the frame answered, which set the mode, so a later pass only reconciles the
 * session.
 */
type Found =
  | { kind: 'unread' }
  | { kind: 'walletUnread'; dead: Reconciled['dead']; last: Restored }
  | { kind: 'walletRead'; wallet: AnsweredWallet; dead: Reconciled['dead']; last: Restored };

/**
 * `passing` runs a pass for `asker`, with the callers `queued` behind it in the order they asked. `kept` is the answer
 * for the page. `servesSites` is whether the window serves a site, so it boots on the stored wallet it otherwise keeps
 * as data.
 */
type BootState =
  | { kind: 'idle'; found: Found; servesSites: boolean }
  | { kind: 'passing'; found: Found; asker: Caller; queued: readonly Caller[]; servesSites: boolean }
  | { kind: 'kept'; wallet: AnsweredWallet; answer: Restored; servesSites: boolean };

type PassingState = Extract<BootState, { kind: 'passing' }>;

type BootEvent =
  | { kind: 'asked'; caller: Caller }
  | { kind: 'passed'; reconciled: Reconciled }
  | { kind: 'passBroke'; error: unknown }
  | { kind: 'sitesServed' };

type BootEffect =
  | { kind: 'runPass' }
  | { kind: 'passBroke'; error: unknown }
  | { kind: 'walletUnavailable'; error: unknown }
  | { kind: 'walletForgotten' }
  | { kind: 'modeChanged'; mode: WalletModeState }
  | { kind: 'restoreKept'; restored: Restored }
  | { kind: 'flagRenewed' }
  | { kind: 'answer'; callers: readonly Caller[]; restored: Restored; local: LocalWalletBoot | null }
  | { kind: 'reject'; caller: Caller; error: unknown };

type BootMachine = MachineTypes<BootState, BootEvent, BootEffect>;

const UNREADABLE = 'Local wallet could not be decrypted and was forgotten';
const UNAVAILABLE = 'Local wallet could not be read, so this page uses Polkadot App';

/** Builds the restore on load. Building it never throws. */
export function createWalletBoot({ reconcile, report, flag, role }: Params) {
  const pairingOnly = isPairingOnly(role);
  const reader: PresenceReader = getLoadReader(role);

  /** A wallet already answered picks the mode again, as the window now boots on a stored local wallet. */
  const serveSites: HandlerOf<BootMachine, 'idle' | 'passing', 'sitesServed'> = (
    state,
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ ...state, servesSites: true });
    if (state.found.kind === 'walletRead') {
      emitSideEffect({ kind: 'modeChanged', mode: getWalletMode(state.found.wallet, true) });
    }
  };
  const machine = createStateMachine<BootMachine>({
    initial: { kind: 'idle', found: { kind: 'unread' }, servesSites: false },
    handlers: {
      idle: {
        asked({ found, servesSites }, { caller }, { emitState, emitSideEffect }) {
          emitState({ kind: 'passing', found, asker: caller, queued: [], servesSites });
          emitSideEffect({ kind: 'runPass' });
        },
        sitesServed: serveSites,
      },
      passing: {
        asked(state, { caller }, { emitState }) {
          emitState({ ...state, queued: [...state.queued, caller] });
        },
        passed(state, { reconciled }, transition) {
          const { found, servesSites } = state;
          const { emitState, emitSideEffect } = transition;
          const dead = (found.kind === 'unread' ? null : found.dead) ?? reconciled.dead;
          const wallet = found.kind === 'walletRead' ? found.wallet : reconciled.wallet;
          const last: Restored = { ...reconciled, wallet, dead, local: getLocalWallet(wallet, servesSites) };
          if (wallet.status === 'failed') {
            emitSideEffect({ kind: 'walletUnavailable', error: wallet.error });
            answerPass(state, { kind: 'walletUnread', dead, last }, transition);
            return;
          }
          if (found.kind !== 'walletRead') {
            if (wallet.status === 'unreadable') {
              emitSideEffect({ kind: 'walletForgotten' });
            }
            // It tells the mode even when the session read failed, so cores can boot, and core storage reports that.
            emitSideEffect({ kind: 'modeChanged', mode: getWalletMode(wallet, servesSites) });
          }
          const { presence, session } = reconciled;
          if (session.status === 'failed') {
            answerPass(state, { kind: 'walletRead', wallet, dead, last }, transition);
            return;
          }
          emitState({ kind: 'kept', wallet, answer: last, servesSites });
          emitSideEffect({ kind: 'restoreKept', restored: last });
          // Renewed rather than set, since a sign-out elsewhere may have deleted it since the read.
          if (presence === 'present' && (session.blob !== null || wallet.status === 'ok')) {
            emitSideEffect({ kind: 'flagRenewed' });
          }
          emitSideEffect({
            kind: 'answer',
            callers: [state.asker, ...state.queued],
            restored: last,
            local: last.local,
          });
        },
        passBroke(state, { error }, transition) {
          transition.emitSideEffect({ kind: 'passBroke', error });
          transition.emitSideEffect({
            kind: 'reject',
            caller: state.asker,
            error: new Error('The restore rule failed', { cause: error }),
          });
          passOn(state, state.found, transition);
        },
        sitesServed: serveSites,
      },
      kept: {
        asked({ wallet, answer, servesSites }, { caller }, { emitSideEffect }) {
          emitSideEffect({
            kind: 'answer',
            callers: [caller],
            restored: answer,
            local: getLocalWallet(wallet, servesSites),
          });
        },
        sitesServed(state, _event, { emitState, emitSideEffect }) {
          emitState({ ...state, servesSites: true });
          emitSideEffect({ kind: 'modeChanged', mode: getWalletMode(state.wallet, true) });
        },
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'runPass':
          machine.update(
            // Started in the chain, so a rule that throws before it returns a promise breaks the pass like a rejection.
            Promise.resolve(reader)
              .then(reconcile)
              .then(
                reconciled => ({ kind: 'passed', reconciled }),
                (error: unknown) => ({ kind: 'passBroke', error }),
              ),
          );
          return;
        case 'passBroke':
          walletReport.defect(effect.error, {
            step: 'restore',
            metric: walletBootTransitionMetric,
            message: '[dot.li wallet] the restore rule rejected:',
          });
          return;
        case 'walletUnavailable':
          // The environment's failure, so each pass that met it is a breadcrumb and a count.
          walletReport.expected(effect.error, {
            step: 'local_wallet',
            metric: walletLocalActivateMetric,
            reason: 'read',
          });
          report({ mode: 'app', failure: UNAVAILABLE });
          return;
        case 'walletForgotten':
          reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
          return;
        case 'modeChanged':
          report(effect.mode);
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
        case 'flagRenewed':
          flag.renew();
          return;
        case 'answer':
          for (const caller of effect.callers) {
            switch (caller.kind) {
              case 'restore':
                caller.resolve(effect.restored);
                break;
              case 'read':
                caller.resolve(effect.local);
                break;
            }
          }
          return;
        case 'reject':
          effect.caller.reject(effect.error);
          return;
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
  function getLocalWallet(wallet: WalletRead, servesSites: boolean): LocalWalletBoot | null {
    return wallet.status === 'ok' && (!pairingOnly || servesSites) ? wallet : null;
  }

  /** The mode `wallet` picks, with why a wallet that no longer decrypts was forgotten. */
  function getWalletMode(wallet: AnsweredWallet, servesSites: boolean): WalletModeState {
    return {
      mode: getLocalWallet(wallet, servesSites) === null ? 'app' : 'local',
      failure: getWalletFailure(wallet),
    };
  }

  return {
    /**
     * What the restore rule left of the stored sign-in. Kept for the page once the frame answered both the session and
     * the wallet read, so the rule runs before boot picks a wallet mode and before any core or session state reads the
     * session. A read it could not answer was not reconciled, so the next caller applies the rule again. The first
     * wallet answered keeps the mode, and the first dead session found stays in the answer. A caller that asks during
     * a pass waits for it, and takes its answer once it is kept. Rejects only when the restore rule breaks its contract
     * and rejects, with that rejection as the cause.
     */
    restore(): Promise<Restored> {
      return new Promise((resolve, reject) => {
        machine.update({ kind: 'asked', caller: { kind: 'restore', resolve, reject } });
      });
    },
    /**
     * Null boots the pairing host. A failed read cannot tell the mode, so it falls back to Polkadot App. On a page that
     * only pairs, the sign-in and sign-out windows, a stored wallet never picks the mode, except in a sign-in window
     * that serves a site, which boots on a stored local wallet. Rejects only when the restore rule breaks its contract
     * and rejects, with that rejection as the cause.
     */
    read(): Promise<LocalWalletBoot | null> {
      return new Promise((resolve, reject) => {
        machine.update({ kind: 'asked', caller: { kind: 'read', resolve, reject } });
      });
    },
    /**
     * The sign-in window serves a site from here on, so a stored local wallet picks the mode and the wallet mode is
     * reported again. Called before anything boots a core, as a core already booted keeps the mode it read. Never
     * throws.
     */
    serveSites(): void {
      machine.update({ kind: 'sitesServed' });
    },
  };
}

/** Answers the pass's asker with what it left, short of a kept answer, and hands the pass on. */
function answerPass(
  state: PassingState,
  found: Exclude<Found, { kind: 'unread' }>,
  transition: Transition<BootMachine>,
): void {
  transition.emitSideEffect({ kind: 'answer', callers: [state.asker], restored: found.last, local: found.last.local });
  passOn(state, found, transition);
}

/** Runs the next queued caller's own pass over what the passes found, or goes idle when none waits. */
function passOn(
  { queued, servesSites }: PassingState,
  found: Found,
  { emitState, emitSideEffect }: Transition<BootMachine>,
): void {
  const [asker, ...rest] = queued;
  if (asker === undefined) {
    emitState({ kind: 'idle', found, servesSites });
    return;
  }
  emitState({ kind: 'passing', found, asker, queued: rest, servesSites });
  emitSideEffect({ kind: 'runPass' });
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
