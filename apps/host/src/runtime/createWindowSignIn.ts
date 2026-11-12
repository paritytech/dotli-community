// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in route of a page with the sign-in window. It signs in and out through the window, and the modal only
// waits for it.

import { defineCount } from '@dotli/metrics';
import { getErrorMessage, type Transition } from '@dotli/shared';
import type { ModalSteps } from './createAuthController.js';
import type { SignInIntent } from './sessionHandoff/parseWindowRequest.js';
import type { SessionHandoff } from './sessionHandoff/createSessionHandoff.js';
import type { SessionResult } from './sessionHandoff/parseSessionResult.js';
import {
  isLeaseHeld,
  isWaiting,
  type AuthModalEvent,
  type AuthModalMachine,
  type LiveModal,
  type SignInRoute,
  type SignInRound,
  type StartLoginParams,
} from './signInRoute.js';
import { reportWalletFailure } from './walletFailure.js';

/**
 * Count. A sign-in window's result the page could not write into its copy. Tagged `outcome` (`error`) and `reason`,
 * the round's intent (`signin, phrase, resume`).
 */
const sessionWindowApplyMetric = defineCount<'error'>('session_window.apply');

type Params = {
  /** The page's sign-in and sign-out windows. */
  handoff: SessionHandoff;
  /** Writes the window's result into this page's copy. Rejects with the failed step as the cause. */
  applyResult: (result: SessionResult) => Promise<'applied' | 'reloading'>;
  /** Whether the page shows signed out while a sign-in made elsewhere waits, which a sign-in then resumes. */
  elsewhere: () => boolean;
  /** Whether the page runs on a local wallet now. Never throws. */
  isLocalWallet: () => boolean;
  /** The page's sign-in modal. */
  modal: Pick<ModalSteps, 'open' | 'show' | 'getViewKind'>;
};

type SignInThroughWindowParams = StartLoginParams & {
  /** What the window is opened for. */
  intent: SignInIntent;
};

/** Builds the sign-in route through the window. Building it never throws. */
export function createWindowSignIn({ handoff, applyResult, elsewhere, isLocalWallet, modal }: Params): SignInRoute {
  /** Opens the window and its wait, or brings the window of the wait on show to the front. */
  function signInThroughWindow(
    state: LiveModal,
    { intent, reason, label }: SignInThroughWindowParams,
    transition: Transition<AuthModalMachine>,
  ): void {
    if (isWaiting(state.round)) {
      handoff.focus();
      return;
    }
    // First, before any wait, since a browser opens a window only in the click's own turn.
    const outcome = handoff.signIn(intent);
    // A prompt or a failure on show keeps its product's name. When the modal does not open the window still opens and
    // its result is still written. That page shows no wait, and its outcomes only write the closed modal's store: a
    // blocked or refused view nobody sees, while a failed write is only reported.
    const base = isLeaseHeld(state.lease) ? state : (modal.open(state, { reason, label }, transition) ?? state);
    const round: SignInRound = { kind: 'windowOpen', intent };
    transition.emitState({ ...base, round });
    if (isLeaseHeld(base.lease)) {
      modal.show({ kind: 'window' }, transition);
    }
    transition.update(outcome.then((ended): AuthModalEvent => ({ kind: 'windowEnded', round, outcome: ended })));
  }

  return {
    startLogin(state, { params }, transition) {
      signInThroughWindow(state, { ...params, intent: elsewhere() ? 'resume' : 'signin' }, transition);
    },
    importPhrase(state, _event, transition) {
      signInThroughWindow(state, { intent: 'phrase' }, transition);
    },
    /**
     * A product asked the core to log in, from a click inside its own frame, which cannot open a window. The prompt's
     * Sign in gives the click. A failure on show is replaced, while a prompt already up, the wait for the window and its
     * outcome stay, so the core's later pairing updates write nothing. The prompt ends a closed round whose failure it
     * replaces.
     */
    pairing(state, pairing, transition) {
      if (isWaiting(state.round)) {
        return;
      }
      if (isLeaseHeld(state.lease) && modal.getViewKind() !== 'error') {
        return;
      }
      const opened = modal.open(
        state,
        { label: pairing.hostGlobal === true ? undefined : pairing.label, dotSuffix: pairing.dotSuffix },
        transition,
      );
      transition.emitState({ ...(opened ?? state), round: { kind: 'idle' } });
      if (opened !== null) {
        modal.show({ kind: 'prompt', resume: elsewhere() }, transition);
      }
    },
    signOut() {
      // First, before any wait, since a browser opens a window only in the click's own turn. A paired page tells the
      // phone itself, about the session its copy holds. The signed-in flag is not the route's to write.
      handoff.signOut({ notified: !isLocalWallet() });
    },
    focus() {
      handoff.focus();
    },
    end(reason) {
      // A window left open would sign in a page that already closed its wait.
      handoff.cancel(reason);
    },
    rounds: {
      idle: null,
      windowOpen: {
        windowEnded({ intent }, { outcome }, transition) {
          const { emitState, update } = transition;
          switch (outcome.kind) {
            case 'cancelled':
              emitState({ kind: 'idle' });
              // The user gave up in the window, so a product's login waiting on the core is answered too.
              update({ kind: 'closeAsked', params: {} });
              return;
            case 'blocked':
            case 'refused':
              emitState({ kind: 'windowClosed', intent });
              modal.show({ kind: outcome.kind }, transition);
              return;
            case 'result':
              break;
          }
          // The round stays the modal's while the result is written, so Sign in meanwhile starts no second round.
          const writing: SignInRound = { kind: 'resultWriting', intent };
          emitState(writing);
          update(
            applyResult(outcome.result).then(
              (written): AuthModalEvent => ({ kind: 'resultWritten', round: writing, written }),
              (error: unknown): AuthModalEvent => {
                reportWalletFailure(error, {
                  what: 'writing the sign-in window result',
                  step: 'session_window',
                  reason: intent,
                  metric: sessionWindowApplyMetric,
                });
                return { kind: 'resultFailed', round: writing, reason: getErrorMessage(error) };
              },
            ),
          );
        },
      },
      resultWriting: {
        resultWritten(_round, { written }, { update }) {
          // A page that reloads keeps the wait on show until it goes. A product's login pending on the core needs no
          // cancel: the core cancels its own pairing once it installs the session from the copy and answers that login
          // as already connected.
          if (written === 'applied') {
            update({ kind: 'closeAsked', params: { skipTruapiCancel: true } });
          }
        },
        resultFailed({ intent }, { reason }, { emitState, update }) {
          emitState({ kind: 'windowClosed', intent });
          update({ kind: 'failureShown', failure: 'Other', reason });
        },
      },
      windowClosed: null,
      phraseLoading: null,
      phraseShown: null,
      phraseFailed: null,
    },
  };
}
