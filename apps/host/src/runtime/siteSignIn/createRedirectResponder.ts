// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The session window's side of a redirect sign-in, which a site uses when it cannot keep a popup. Vetting already named
 * the site, so the round starts vetted as a third party for the return address's origin. The one answer of the round,
 * the message popup mode would post, is sealed to the site's key and carried back in the return address's fragment, and
 * the navigation ends the window's page.
 */

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, type MachineTypes } from '@dotli/shared';
import { computed } from 'nanostores';
import type { Responder, ResponderState } from '../sessionHandoff/createResponder.js';
import {
  createCancelledMessage,
  createRefusedMessage,
  createResultMessage,
  type PageMessage,
} from '../sessionHandoff/sessionMessages.js';

type Params = {
  /** The vetted origin of the return address. */
  origin: string;
  round: string;
  /** Seals the answer into the return address. Rejects when the answer cannot be sealed. */
  seal: (message: PageMessage) => Promise<string>;
  /**
   * Ends the window's page at `url`. Forgets the window's kept request first, so the page the browser keeps in history
   * never answers this round again.
   */
  navigate: (url: string) => void;
  /** Takes a failure to seal the answer, which leaves the site unanswered, and the site token the answer carried. */
  failed: (error: unknown, siteToken: string | undefined) => void;
};

/**
 * Where the round's one answer stands: `waiting` before the round ends, `sealing` while it is sealed, `sent` once the
 * window navigates with it, and `failed` when sealing failed, which leaves the site unanswered.
 */
type RedirectState =
  | { kind: 'waiting' }
  | { kind: 'sealing'; answer: ResponderState; siteToken: string | undefined }
  | { kind: 'sent'; answer: ResponderState }
  | { kind: 'failed'; answer: ResponderState };

type RedirectEvent =
  | { kind: 'answered'; answer: ResponderState; message: PageMessage; siteToken: string | undefined }
  | { kind: 'sealed'; url: string }
  | { kind: 'sealFailed'; error: unknown };

type RedirectEffect =
  { kind: 'sealed'; url: string } | { kind: 'sealFailed'; error: unknown; siteToken: string | undefined };

type RedirectMachine = MachineTypes<RedirectState, RedirectEvent, RedirectEffect>;

/** The window's responder in a redirect sign-in, which also says where its answer stands. */
export type RedirectResponder = ReturnType<typeof createRedirectResponder>;

const report = createReporter({ flow: 'wallet' });
const redirectResponderTransitionMetric = defineCount<'error'>('session_pages.redirect_responder_transition');

/** Makes the responder of a redirect sign-in, vetted for `origin` from the start. */
export function createRedirectResponder({ origin, round, seal, navigate, failed }: Params) {
  const machine = createStateMachine<RedirectMachine>({
    initial: { kind: 'waiting' },
    handlers: {
      waiting: {
        answered(_state, { answer, message, siteToken }, { emitState, update }) {
          emitState({ kind: 'sealing', answer, siteToken });
          update(
            seal(message).then(
              (url): RedirectEvent => ({ kind: 'sealed', url }),
              (error: unknown): RedirectEvent => ({ kind: 'sealFailed', error }),
            ),
          );
        },
      },
      sealing: {
        sealed({ answer }, { url }, { emitState, emitSideEffect }) {
          emitState({ kind: 'sent', answer });
          emitSideEffect({ kind: 'sealed', url });
        },
        sealFailed({ answer, siteToken }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'failed', answer });
          emitSideEffect({ kind: 'sealFailed', error, siteToken });
        },
      },
      sent: null,
      failed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'sealed':
          navigate(effect.url);
          return;
        case 'sealFailed':
          failed(effect.error, effect.siteToken);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: redirectResponderTransitionMetric,
        message: '[dot.li] A redirect responder transition threw',
      });
    },
  });

  const responder: Responder<unknown> = {
    state: computed(machine.state, (current): ResponderState => {
      switch (current.kind) {
        case 'waiting':
          return { kind: 'vetted', origin, party: 'third' };
        case 'sealing':
        case 'sent':
        case 'failed':
          return current.answer;
      }
    }),
    send(result, { siteToken } = {}) {
      machine.update({
        kind: 'answered',
        answer: { kind: 'answered' },
        message: createResultMessage({ round, result, siteToken }),
        siteToken,
      });
    },
    refuse(reason) {
      machine.update({
        kind: 'answered',
        answer: { kind: 'refused' },
        message: createRefusedMessage(round, reason),
        siteToken: undefined,
      });
    },
    cancel() {
      machine.update({
        kind: 'answered',
        answer: { kind: 'answered' },
        message: createCancelledMessage(round),
        siteToken: undefined,
      });
    },
    // Redirect mode sends no payload, so the call never comes.
    payload: () => new Promise<string>(() => undefined),
    /**
     * Does nothing, since the responder holds no listener or timer, is safe to call twice, and leaves an answer already
     * being sealed to navigate the window once sealed.
     */
    dispose: () => undefined,
  };

  return {
    ...responder,
    /** Where the round's one answer stands now. */
    delivery: (): RedirectState['kind'] => machine.state.get().kind,
  };
}
