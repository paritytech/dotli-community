// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in window shows of a sign-in: its views, the account Continue offers and how far a pairing got.

import type { PairingView } from '../account/index.js';
import type { ContinueOffer, OfferedAccount, SignInScreen, WindowFailure } from './sessionWindowState.js';
import { getLoginFailureView } from '../account/index.js';
import { authViews } from '../account/index.js';
import { getLocalSessionUiState } from '../account/index.js';
import { parseUiStateCache, type TruapiSessionUiState } from '../account/index.js';
import type { DotliAuthState } from '../account/index.js';
import type { ResponderState } from './createResponder.js';
import type { SessionResult } from './parseSessionResult.js';

/** What Continue offers, with the stored sign-in it was read from. */
export type Offered = { stored: SessionResult; offer: ContinueOffer };

/**
 * The view on show: one of a round's, the pairing's with how far it got, or Continue's with what it offers and the
 * failure on it.
 */
export type Shown =
  | { view: 'connecting' | 'phrase' | 'failed' }
  | { view: 'pairing'; pairing: PairingView }
  | { view: 'continue'; offered: Offered; failure: WindowFailure | null };

export const SPINNER: PairingView = { kind: 'spinner' };

/** The screen of `shown`, which names `page`, the page the window signs in for, null when no page opened it. */
export function getSignInScreen(shown: Shown, page: string | null): SignInScreen {
  switch (shown.view) {
    case 'continue':
      return { view: 'continue', offer: shown.offered.offer, pageHost: page, failure: shown.failure };
    case 'pairing':
      return { view: 'pairing', pageHost: page, failure: null, pairing: shown.pairing };
    case 'connecting':
    case 'phrase':
    case 'failed':
      return { view: shown.view, pageHost: page, failure: null };
  }
}

/** The view the window stops on, which still names `page`. */
export function getStopScreen(view: 'refused' | 'done-no-opener', page: string | null): SignInScreen {
  return { view, pageHost: page, failure: null };
}

/** What the window shows before its flow decides anything: it waits on its opener, or turned it away. */
export function getResponderScreen(state: ResponderState): SignInScreen {
  return { view: state.kind === 'refused' ? 'refused' : 'connecting', pageHost: null, failure: null };
}

/** What Continue offers from `stored`: the local wallet when one is stored, since a page boots on it, else the session. */
export function getOffered(stored: SessionResult): Offered | null {
  const { localWallet, session } = stored;
  if (localWallet !== null) {
    const { identity } = localWallet;
    const account = identity === null ? null : getOfferedAccount(getLocalSessionUiState(identity));
    return { stored, offer: { wallet: 'local', account } };
  }
  if (session !== null) {
    const account = getOfferedAccount(parseUiStateCache(session.uiState));
    return { stored, offer: { wallet: 'paired', account } };
  }
  return null;
}

/** How far the core's pairing got. A disconnect leaves `shown`, so a failure stays up for Retry. */
export function getPairingView(shown: PairingView, state: DotliAuthState): PairingView {
  const step = authViews.getLoginStep(state);
  switch (step?.step) {
    case 'pairing':
      return step.pairing.deeplink ? { kind: 'pairing', payload: step.pairing.deeplink } : SPINNER;
    case 'authenticating':
      return { kind: 'authenticating' };
    case 'failed':
      return getLoginFailureView(step.kind, step.reason);
    case undefined:
      return authViews.getSignedInSession(state) === null ? shown : SPINNER;
  }
}

/** What a login the core ended says, when the core said nothing of its own about it. */
export function getEndedLoginView(how: 'failed' | 'cancelled'): PairingView {
  return getLoginFailureView('Other', how === 'failed' ? 'The sign-in did not complete' : 'The sign-in was cancelled');
}

function getOfferedAccount(uiState: TruapiSessionUiState | null): OfferedAccount | null {
  if (uiState === null) {
    return null;
  }
  const { connected, ...account } = uiState;
  return connected ? account : null;
}
