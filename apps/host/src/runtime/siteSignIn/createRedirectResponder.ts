// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The session window's side of a redirect sign-in, which a site uses when it cannot keep a popup. Vetting already named
 * the site, so the round starts vetted as a third party for the return address's origin. The one answer of the round,
 * the message popup mode would post, is sealed to the site's key and carried back in the return address's fragment, and
 * the navigation ends the window's page.
 */

import { createSyncStore } from '@dotli/shared';
import type { Responder, ResponderState } from '../sessionHandoff/createResponder.js';
import {
  createCancelledMessage,
  createRefusedMessage,
  createResultMessage,
  type PageMessage,
} from '../sessionHandoff/sessionMessages.js';
import type { sealRedirect } from './siteSeal.js';

type Params = {
  /** The vetted origin of the return address. */
  origin: string;
  returnTo: string;
  /** The site's temporary key. */
  sitePublicKey: Uint8Array;
  round: string;
  /** Seals the answer into the return address. Rejects when the answer cannot be sealed. */
  seal: typeof sealRedirect;
  /** Forgets the window's kept request, so a step back to the window answers no round. */
  forgetRequest: () => void;
  /** Navigates the window's page to `url`, which ends the page. */
  navigate: (url: string) => void;
  /** Takes a failure to seal the answer, which leaves the site unanswered, and the site token the answer carried. */
  failed: (error: unknown, siteToken: string | undefined) => void;
};

type SendAnswerParams = {
  /** The responder's state once the round ends. */
  state: ResponderState;
  message: PageMessage;
  siteToken?: string | undefined;
};

/**
 * Where the round's one answer stands: `none` before the round ends, `pending` while it is sealed, `sent` once the
 * window navigates with it, and `failed` when sealing failed, which leaves the site unanswered.
 */
export type RedirectDelivery = 'none' | 'pending' | 'sent' | 'failed';

/** The window's responder in a redirect sign-in, which also says where its answer stands. */
export type RedirectResponder = ReturnType<typeof createRedirectResponder>;

// Redirect mode sends no payload, so the call never comes.
const NO_PAYLOAD = new Promise<string>(() => undefined);

/** Makes the responder of a redirect sign-in, vetted for `origin` from the start. */
export function createRedirectResponder({
  origin,
  returnTo,
  sitePublicKey,
  round,
  seal,
  forgetRequest,
  navigate,
  failed,
}: Params) {
  const store = createSyncStore<ResponderState>({
    name: 'redirectResponder',
    initial: { kind: 'vetted', origin, party: 'third' },
  });
  let delivery: RedirectDelivery = 'none';

  /**
   * Ends the round with `state` and sends `message` back sealed, once. The delivery is pending before the seal, so a
   * second call while it runs does nothing.
   */
  function sendAnswer({ state, message, siteToken }: SendAnswerParams): void {
    if (delivery !== 'none') {
      return;
    }
    delivery = 'pending';
    store.set(state);
    seal({ returnTo, sitePublicKey, round, message }).then(
      url => {
        delivery = 'sent';
        // Forgotten first, so the page the browser keeps in history never answers this round again.
        forgetRequest();
        navigate(url);
      },
      (error: unknown) => {
        delivery = 'failed';
        failed(error, siteToken);
      },
    );
  }

  const responder: Responder<unknown> = {
    state: store.get,
    subscribe: store.listen,
    send(result, { siteToken } = {}) {
      sendAnswer({
        state: { kind: 'answered' },
        message: createResultMessage({ round, result, siteToken }),
        siteToken,
      });
    },
    refuse(reason) {
      sendAnswer({ state: { kind: 'refused' }, message: createRefusedMessage(round, reason) });
    },
    cancel() {
      sendAnswer({ state: { kind: 'answered' }, message: createCancelledMessage(round) });
    },
    payload: () => NO_PAYLOAD,
    /**
     * Does nothing, since the responder holds no listener or timer, is safe to call twice, and leaves an answer already
     * being sealed to navigate the window once sealed.
     */
    dispose: () => undefined,
  };

  return {
    ...responder,
    /** Where the round's one answer stands now. */
    delivery: (): RedirectDelivery => delivery,
  };
}
