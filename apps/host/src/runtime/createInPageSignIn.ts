// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in route of a page with no sign-in window. It pairs in place on the core, in the bridge chunk, and takes a
// recovery phrase in the modal.

import { getErrorMessage } from '@dotli/shared';
import { createReporter } from '@dotli/metrics';
import { reportLazyMiss } from '../reportLazyMiss.js';
import type { ModalSteps } from './createAuthController.js';
import {
  isLeaseHeld,
  isPhraseRound,
  type AuthModalEvent,
  type InPagePhrase,
  type SignInRound,
  type SignInRoute,
} from './signInRoute.js';

const report = createReporter({ flow: 'wallet' });

type Params = {
  /** Loaded the first time the page asks for a phrase, so a page that never asks loads none of it. */
  inPagePhrase: () => Promise<InPagePhrase>;
  /** The page's sign-in modal, which this route shows its views on, and the core's login. */
  modal: Pick<ModalSteps, 'open' | 'show' | 'getViewKind' | 'login'>;
};

/** Returns the sign-in route of a page with no sign-in window. Never throws. */
export function createInPageSignIn({ inPagePhrase, modal }: Params): SignInRoute {
  return {
    startLogin(state, { params: { reason, label } }, transition) {
      // The modal already shows that login, and a reset would swap its QR for a spinner that never resolves. An error
      // shows none, so its Retry logs in again.
      if (isLeaseHeld(state.lease) && modal.getViewKind() !== 'error') {
        return;
      }
      if (modal.open(state, { reason, label }, transition) === null) {
        return;
      }
      modal.login({ reason }, transition);
    },
    importPhrase(state, _event, transition) {
      const opened = modal.open(state, {}, transition);
      if (opened === null) {
        return;
      }
      // The phrase view shows only once its check loaded.
      const round: SignInRound = { kind: 'phraseLoading' };
      transition.emitState({ ...opened, round });
      transition.update(
        inPagePhrase().then(
          (phrase): AuthModalEvent => ({ kind: 'phraseLoaded', round, phrase }),
          (error: unknown): AuthModalEvent => {
            reportLazyMiss({ report, step: 'phrase_import', error });
            return { kind: 'phraseMissed', round, reason: getErrorMessage(error) };
          },
        ),
      );
    },
    pairing(state, pairing, transition) {
      const opened = modal.open(
        state,
        { label: pairing.hostGlobal === true ? undefined : pairing.label, dotSuffix: pairing.dotSuffix },
        transition,
      );
      // A pairing on show replaces a phrase view that failed to load, so Retry logs in again.
      transition.emitState({
        ...(opened ?? state),
        round: isPhraseRound(state.round) ? { kind: 'idle' } : state.round,
      });
      if (pairing.deeplink) {
        modal.show({ kind: 'pairing', payload: pairing.deeplink }, transition);
      }
    },
    signOut() {
      // A page with no sign-in window has no sign-out window to open.
    },
    focus() {
      // A page with no sign-in window has nothing to bring forward.
    },
    end() {
      // A page with no sign-in window has no round of its own to end.
    },
    rounds: {
      idle: null,
      rereading: null,
      windowOpen: null,
      resultWriting: null,
      windowClosed: null,
      phraseLoading: {
        phraseLoaded(_round, { phrase }, transition) {
          transition.emitState({ kind: 'phraseShown', phrase });
          modal.show({ kind: 'phrase' }, transition);
        },
        phraseMissed(_round, { reason }, { emitState, update }) {
          emitState({ kind: 'phraseFailed' });
          update({ kind: 'failureShown', failure: 'Other', reason });
        },
      },
      phraseShown: null,
      phraseFailed: null,
    },
  };
}
