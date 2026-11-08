// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in route of a page with the sign-in window. It signs in and out through the window, and the modal only
// waits for it.

import { defineCount } from '@dotli/metrics';
import { getErrorMessage } from '@dotli/shared';
import type { PairingState } from './session/types.js';
import type { SignInIntent } from './sessionHandoff/parseWindowRequest.js';
import type { SessionHandoff, SignInOutcome } from './sessionHandoff/createSessionHandoff.js';
import type { SessionResult } from './sessionHandoff/parseSessionResult.js';
import type { AuthModalPort, SignInRoute, StartLoginParams } from './signInRoute.js';
import { reportLocalWalletFailure, reportWalletFailure } from './walletFailure.js';

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
  modal: AuthModalPort;
};

/**
 * The window round on show: open from the click until its outcome is shown or its result written, then closed while
 * its blocked, refused or failed view is on show, whose Retry opens the window again with the round's intent.
 */
type WindowRound = {
  readonly intent: SignInIntent;
  open: boolean;
};

/** Builds the sign-in route through the window. Building it never throws. */
export function createWindowSignIn({ handoff, applyResult, elsewhere, isLocalWallet, modal }: Params): SignInRoute {
  // The window round on show. Closing the modal ends it, so an outcome that arrives later changes nothing on screen.
  let round: WindowRound | null = null;

  /**
   * A product asked the core to log in, from a click inside its own frame, which cannot open a window. The prompt's
   * Sign in gives the click. A failure on show is replaced, while a prompt already up, the wait for the window and its
   * outcome stay, so the core's later pairing updates write nothing.
   */
  function promptForWindow(state: PairingState): void {
    if (round?.open === true) {
      return;
    }
    if (modal.getLease() !== null && modal.getViewKind() !== 'error') {
      return;
    }
    if (modal.open({ label: state.hostGlobal === true ? undefined : state.label, dotSuffix: state.dotSuffix })) {
      modal.show({ kind: 'prompt', resume: elsewhere() });
    }
  }

  function signInThroughWindow(intent: SignInIntent, { reason, label }: StartLoginParams = {}): void {
    if (round?.open === true) {
      handoff.focus();
      return;
    }
    // First, before any wait, since a browser opens a window only in the click's own turn.
    const outcome = handoff.signIn(intent);
    const started: WindowRound = { intent, open: true };
    round = started;
    // A prompt or a failure on show keeps its product's name. When open answers false the window still opens and its
    // result is still written. That page shows no wait, and its outcomes only write the closed modal's store: a blocked
    // or refused view nobody sees, and for a failed write the reported failure, whose reopen gets false from open.
    if (modal.getLease() !== null || modal.open({ reason, label })) {
      modal.show({ kind: 'window' });
    }
    void outcome.then(ended => endWindowRound(started, ended));
  }

  async function endWindowRound(windowRound: WindowRound, outcome: SignInOutcome): Promise<void> {
    if (round !== windowRound) {
      return;
    }
    switch (outcome.kind) {
      case 'cancelled':
        // The user gave up in the window, so a product's login waiting on the core is answered too.
        modal.close();
        return;
      case 'blocked':
      case 'refused':
        windowRound.open = false;
        modal.show({ kind: outcome.kind });
        return;
      case 'result':
        break;
    }
    // The round stays the modal's while the result is written, so Sign in meanwhile starts no second round.
    let written: 'applied' | 'reloading';
    try {
      written = await applyResult(outcome.result);
    } catch (error) {
      reportWalletFailure(error, {
        what: 'writing the sign-in window result',
        step: 'session_window',
        reason: windowRound.intent,
        metric: sessionWindowApplyMetric,
      });
      if (round === windowRound) {
        windowRound.open = false;
        modal.showFailure('Other', getErrorMessage(error));
      }
      return;
    }
    // A page that reloads keeps the wait on show until it goes. A product's login pending on the core needs no cancel:
    // the core cancels its own pairing once it installs the session from the copy and answers that login as already
    // connected.
    if (round === windowRound && written === 'applied') {
      modal.close({ skipTruapiCancel: true });
    }
  }

  return {
    startLogin(params) {
      signInThroughWindow(elsewhere() ? 'resume' : 'signin', params);
    },
    importPhrase() {
      signInThroughWindow('phrase');
    },
    isPhraseRound() {
      return round?.intent === 'phrase';
    },
    pairing(state) {
      promptForWindow(state);
    },
    isWaiting() {
      return round?.open === true;
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
      round = null;
      // A window left open would sign in a page that already closed its wait.
      handoff.cancel(reason);
    },
    isValidPhrase() {
      return false;
    },
    importPhraseInPage() {
      // This route has no phrase view, so a call here is a fault of the page and not of the input.
      const error = new Error('The recovery phrase import was not loaded');
      reportLocalWalletFailure(error, 'phrase-load');
      return Promise.reject(error);
    },
  };
}
