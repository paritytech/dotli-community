// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's restore on load. It applies the restore rule to the page's copy, and the wallet the rule leaves is the
// page's wallet mode.

import { createReporter, defineCount } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createStateMachine, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import { reportLocalWalletFailure, walletLocalActivateMetric } from './walletFailure.js';
import { getLoadReader, isPairingOnly, isFlagShared, type PageRole } from './pageRole.js';
import type { PresenceReader, Reconciled } from './session/restoreRule.js';
import { sessionPresenceMetric } from './session/sessionPresenceMetric.js';
import type { WalletRead } from './session/siteWallet.js';
import type { SignInFlag } from './session/signInFlag.js';
import type { WalletModeState } from './state/walletModeState.js';

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
 * `idle` and `passing` hold what the passes so far found short of an answer to keep: the first dead session a pass
 * found, since a later pass finds the store already empty, and the first wallet the frame answered, which set the mode,
 * so a later pass only reconciles the session. `passing` runs a pass for `asker`, with the callers `queued` behind it
 * in the order they asked. `kept` is the answer for the page. `bootsOnStored` is whether a stored wallet picks the
 * mode, which a page that only pairs keeps as data until it serves a site.
 */
type BootState =
  | { kind: 'idle'; dead: Reconciled['dead']; wallet: AnsweredWallet | null; bootsOnStored: boolean }
  | {
      kind: 'passing';
      dead: Reconciled['dead'];
      wallet: AnsweredWallet | null;
      bootsOnStored: boolean;
      asker: Caller;
      queued: readonly Caller[];
    }
  | { kind: 'kept'; wallet: AnsweredWallet; answer: Restored; bootsOnStored: boolean };

type PassingState = Extract<BootState, { kind: 'passing' }>;

type BootEvent =
  | { kind: 'asked'; caller: Caller }
  | { kind: 'passed'; reconciled: Reconciled }
  | { kind: 'passBroke'; error: unknown }
  | { kind: 'sitesServed' };

type BootEffect =
  | { kind: 'passBroke'; caller: Caller; error: unknown }
  | { kind: 'walletUnavailable'; error: unknown }
  | { kind: 'walletForgotten' }
  | { kind: 'modeChanged'; mode: WalletModeState }
  | { kind: 'flagUnreadable' }
  | { kind: 'walletKeptAsData' }
  | { kind: 'flagRenewed' }
  | { kind: 'answer'; callers: readonly Caller[]; restored: Restored; local: LocalWalletBoot | null };

type BootMachine = MachineTypes<BootState, BootEvent, BootEffect>;

const UNREADABLE = 'Local wallet could not be decrypted and was forgotten';
const UNAVAILABLE = 'Local wallet could not be read, so this page uses Polkadot App';

/** Builds the restore on load. Building it never throws. */
export function createWalletBoot({ reconcile, report, flag, role }: Params) {
  const reader: PresenceReader = getLoadReader(role);
  const machine = createStateMachine<BootMachine>({
    initial: { kind: 'idle', dead: null, wallet: null, bootsOnStored: !isPairingOnly(role) },
    handlers: {
      idle: {
        asked(state, { caller }, transition) {
          runPass({ ...state, kind: 'passing', asker: caller, queued: [] }, transition);
        },
        sitesServed: serveSites,
      },
      passing: {
        asked(state, { caller }, { emitState }) {
          emitState({ ...state, queued: [...state.queued, caller] });
        },
        passed(state, { reconciled }, transition) {
          const { emitState, emitSideEffect } = transition;
          const dead = state.dead ?? reconciled.dead;
          const wallet = state.wallet ?? reconciled.wallet;
          const restored: Restored = {
            ...reconciled,
            wallet,
            dead,
            local: getLocalWallet(wallet, state.bootsOnStored),
          };
          if (state.wallet === null) {
            if (wallet.status === 'failed') {
              emitSideEffect({ kind: 'walletUnavailable', error: wallet.error });
            }
            if (wallet.status === 'unreadable') {
              emitSideEffect({ kind: 'walletForgotten' });
            }
            // It tells the mode even when a read failed, so cores can boot, and core storage reports a failed session.
            emitSideEffect({ kind: 'modeChanged', mode: getWalletMode(wallet, state.bootsOnStored) });
          }
          if (wallet.status === 'failed') {
            answerPass({ ...state, dead }, restored, transition);
            return;
          }
          const { presence, session } = reconciled;
          if (session.status === 'failed') {
            answerPass({ ...state, dead, wallet }, restored, transition);
            return;
          }
          emitState({ kind: 'kept', wallet, answer: restored, bootsOnStored: state.bootsOnStored });
          if (presence === 'unknown' && isFlagShared(role)) {
            emitSideEffect({ kind: 'flagUnreadable' });
          }
          if (wallet.status === 'ok' && restored.local === null) {
            emitSideEffect({ kind: 'walletKeptAsData' });
          }
          // Renewed rather than set, since a sign-out elsewhere may have deleted it since the read.
          if (presence === 'present' && (session.blob !== null || wallet.status === 'ok')) {
            emitSideEffect({ kind: 'flagRenewed' });
          }
          emitSideEffect({ kind: 'answer', callers: [state.asker, ...state.queued], restored, local: restored.local });
        },
        passBroke(state, { error }, transition) {
          transition.emitSideEffect({ kind: 'passBroke', caller: state.asker, error });
          passOn(state, transition);
        },
        sitesServed: serveSites,
      },
      kept: {
        asked({ wallet, answer, bootsOnStored }, { caller }, { emitSideEffect }) {
          emitSideEffect({
            kind: 'answer',
            callers: [caller],
            restored: answer,
            local: getLocalWallet(wallet, bootsOnStored),
          });
        },
        sitesServed: serveSites,
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'passBroke':
          walletReport.defect(effect.error, {
            step: 'restore',
            metric: walletBootTransitionMetric,
            message: '[dot.li wallet] the restore rule rejected:',
          });
          effect.caller.reject(new Error('The restore rule failed', { cause: effect.error }));
          return;
        case 'walletUnavailable':
          // The environment's failure, so each pass that met it is a breadcrumb and a count.
          walletReport.expected(effect.error, {
            step: 'local_wallet',
            metric: walletLocalActivateMetric,
            reason: 'read',
          });
          return;
        case 'walletForgotten':
          reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
          return;
        case 'modeChanged':
          report(effect.mode);
          return;
        case 'flagUnreadable':
          walletReport.log.event('signed-in flag unreadable, keeping the stored sign-in');
          sessionPresenceMetric.count({ outcome: 'unreadable', reason: reader });
          return;
        case 'walletKeptAsData':
          walletReport.log.event('local wallet kept as data, page pairs');
          return;
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

  /** Moves to `state` and runs its asker's pass over what the passes so far found. */
  function runPass(state: PassingState, { emitState, update }: Transition<BootMachine>): void {
    emitState(state);
    update(
      // Started in the chain, so a rule that throws before it returns a promise breaks the pass like a rejection.
      Promise.resolve(reader)
        .then(reconcile)
        .then(
          reconciled => ({ kind: 'passed', reconciled }),
          (error: unknown) => ({ kind: 'passBroke', error }),
        ),
    );
  }

  /** Answers the pass's asker with what it left, short of a kept answer, and hands the pass on. */
  function answerPass(state: PassingState, restored: Restored, transition: Transition<BootMachine>): void {
    transition.emitSideEffect({ kind: 'answer', callers: [state.asker], restored, local: restored.local });
    passOn(state, transition);
  }

  /** Runs the next queued caller's own pass over what the passes found, or goes idle when none waits. */
  function passOn(state: PassingState, transition: Transition<BootMachine>): void {
    const { dead, wallet, bootsOnStored } = state;
    const [asker, ...queued] = state.queued;
    if (asker === undefined) {
      transition.emitState({ kind: 'idle', dead, wallet, bootsOnStored });
      return;
    }
    runPass({ ...state, asker, queued }, transition);
  }
}

/** A wallet already answered picks the mode again, as the window now boots on a stored local wallet. */
const serveSites: HandlerOf<BootMachine, 'idle' | 'passing' | 'kept', 'sitesServed'> = (
  state,
  _event,
  { emitState, emitSideEffect },
) => {
  emitState({ ...state, bootsOnStored: true });
  if (state.wallet !== null) {
    emitSideEffect({ kind: 'modeChanged', mode: getWalletMode(state.wallet, true) });
  }
};

/** The stored wallet the page boots on, or null when there is none or the page keeps it as data. */
function getLocalWallet(wallet: WalletRead, bootsOnStored: boolean): LocalWalletBoot | null {
  return wallet.status === 'ok' && bootsOnStored ? wallet : null;
}

/** The mode `wallet` picks, with why a wallet that could not be read or no longer decrypts is not used. */
function getWalletMode(wallet: WalletRead, bootsOnStored: boolean): WalletModeState {
  if (wallet.status === 'failed') {
    return { mode: 'app', failure: UNAVAILABLE };
  }
  return {
    mode: getLocalWallet(wallet, bootsOnStored) === null ? 'app' : 'local',
    failure: wallet.status === 'unreadable' ? UNREADABLE : null,
  };
}
