// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The session window's side of a redirect sign-in, which a site uses when it cannot keep a popup. Vetting already named
 * the site, so the round starts vetted as a third party for the return address's origin. The one answer of the round,
 * the message popup mode would post, is sealed to the site's key and carried back in the return address's fragment, and
 * the navigation ends the window's page.
 */

import { createSyncStore } from '@dotli/shared';
import {
  cancelledMessage,
  refusedMessage,
  resultMessage,
  type Responder,
  type ResponderState,
} from '../session-handoff/responder.js';
import type { PageMessage } from '../session-handoff/session-protocol.js';
import type { sealRedirect } from './site-seal.js';

export type RedirectResponderDeps = {
  /** The vetted origin of the return address. */
  origin: string;
  returnTo: string;
  /** The site's temporary key. */
  pub: Uint8Array;
  round: string;
  seal: typeof sealRedirect;
  /** Forgets the window's kept request, so a step back to the window answers no round. */
  forgetRequest: () => void;
  navigate: (url: string) => void;
  /** Takes a failure to seal the answer, which leaves the site unanswered, and the site token the answer carried. */
  failed: (error: unknown, siteToken: string | undefined) => void;
};

/**
 * Where the round's one answer stands: `none` before the round ends, `pending` while it is sealed, `sent` once the
 * window navigates with it, and `failed` when sealing failed, which leaves the site unanswered.
 */
export type RedirectDelivery = 'none' | 'pending' | 'sent' | 'failed';

export type RedirectResponder = {
  delivery(): RedirectDelivery;
} & Responder<unknown>;

// Redirect mode sends no payload, so the call never comes.
const NO_PAYLOAD = new Promise<string>(() => undefined);

export function createRedirectResponder(deps: RedirectResponderDeps): RedirectResponder {
  const { origin, returnTo, pub, round } = deps;
  const store = createSyncStore<ResponderState>('redirectResponder', { kind: 'vetted', origin, party: 'third' });
  let delivery: RedirectDelivery = 'none';

  /**
   * Ends the round with `state` and sends `message` back sealed, once. The delivery is pending before the seal, so a
   * second call while it runs does nothing.
   */
  const answer = (state: ResponderState, message: PageMessage, siteToken?: string): void => {
    if (delivery !== 'none') {
      return;
    }
    delivery = 'pending';
    store.set(state);
    deps.seal(returnTo, pub, round, message).then(
      url => {
        delivery = 'sent';
        // Forgotten first, so the page the browser keeps in history never answers this round again.
        deps.forgetRequest();
        deps.navigate(url);
      },
      (error: unknown) => {
        delivery = 'failed';
        deps.failed(error, siteToken);
      },
    );
  };

  return {
    state: store.get,
    subscribe: listener =>
      store.subscribe(() => {
        listener(store.get());
      }),
    delivery: () => delivery,
    send(result, siteToken) {
      answer({ kind: 'answered' }, resultMessage(round, result, siteToken), siteToken);
    },
    refuse(reason) {
      answer({ kind: 'refused' }, refusedMessage(round, reason));
    },
    cancel() {
      answer({ kind: 'answered' }, cancelledMessage(round));
    },
    payload: () => NO_PAYLOAD,
  };
}
