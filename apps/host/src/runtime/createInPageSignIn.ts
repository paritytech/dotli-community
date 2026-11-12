// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in route of a page with no sign-in window. It pairs in place on the core, in the bridge chunk, and takes a
// recovery phrase in the modal.

import { getErrorMessage } from '@dotli/shared';
import { createReporter } from '@dotli/metrics';
import { reportLazyMiss } from '../reportLazyMiss.js';
import { showView, type ModalSteps } from './authModalSteps.js';
import {
  isLeaseHeld,
  isPhraseRound,
  type AuthModalEvent,
  type InPagePhrase,
  type LiveModal,
  type SignInRound,
  type SignInRoute,
} from './signInRoute.js';

const report = createReporter({ flow: 'wallet' });

type Params = {
  /** Loaded the first time the page asks for a phrase, so a page that never asks loads none of it. */
  inPagePhrase: () => Promise<InPagePhrase>;
  /** The page's sign-in modal, which this route opens. */
  modal: Pick<ModalSteps, 'open'>;
};

/** Returns the sign-in route of a page with no sign-in window. Never throws. */
export function createInPageSignIn({ inPagePhrase, modal }: Params): SignInRoute {
  return {
    startLogin(state, { params: { reason, label } }, transition) {
      // The modal already shows that login, and a reset would swap its QR for a spinner that never resolves. An error
      // shows none, so its Retry logs in again.
      if (isLeaseHeld(state.lease) && state.view.kind !== 'error') {
        return;
      }
      if (modal.open(state, { reason, label }, transition) === null) {
        return;
      }
      transition.emitSideEffect({ kind: 'commandRun', command: { step: 'login', params: { reason } } });
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
      const next: LiveModal = {
        ...(opened ?? state),
        round: isPhraseRound(state.round) ? { kind: 'idle' } : state.round,
      };
      transition.emitState(next);
      if (pairing.deeplink) {
        showView(next, { kind: 'pairing', payload: pairing.deeplink }, transition);
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
      rereadMissed: null,
      windowOpen: null,
      resultWriting: null,
      windowClosed: null,
      phraseLoading: {
        phraseLoaded(_round, { phrase }, { emitState, update }) {
          emitState({ kind: 'phraseShown', phrase });
          update({ kind: 'viewAsked', view: { kind: 'phrase' } });
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
