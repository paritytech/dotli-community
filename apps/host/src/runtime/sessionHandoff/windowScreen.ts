// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in window shows of a sign-in: its views, the account Continue offers and how far a pairing got.

import type { PairingView } from '../../state/authModalState.js';
import type { ContinueOffer, OfferedAccount, SignInScreen, WindowFailure } from '../../state/sessionWindowState.js';
import { getLoginFailureView } from '../getLoginFailureView.js';
import { authViews } from '../session/authViews.js';
import { getLocalSessionUiState } from '../session/getLocalSessionUiState.js';
import { parseUiStateCache, type TruapiSessionUiState } from '../session/parseUiStateCache.js';
import type { DotliAuthState } from '../session/types.js';
import type { ResponderState } from './createResponder.js';
import type { SessionResult } from './parseSessionResult.js';

/** What Continue offers, with the stored sign-in it was read from. */
export type Offered = { stored: SessionResult; offer: ContinueOffer };

/** The view on show: one of a round's, or Continue's with what it offers and the failure on it. */
export type Shown =
  | { view: 'connecting' | 'phrase' | 'pairing' | 'failed' }
  | { view: 'continue'; offered: Offered; failure: WindowFailure | null };

/** What every view of a round carries: the page it signs in for, null with no opener, and how far its pairing got. */
type ScreenRound = { page: string | null; pairing: PairingView };

export const SPINNER: PairingView = { kind: 'spinner' };

/** The screen of `shown` in `round`. */
export function getSignInScreen({ page, pairing }: ScreenRound, shown: Shown): SignInScreen {
  if (shown.view === 'continue') {
    return { view: 'continue', offer: shown.offered.offer, pageHost: page, failure: shown.failure, pairing };
  }
  return { view: shown.view, pageHost: page, failure: null, pairing };
}

/** The view the window stops on, which keeps the page and the pairing `screen` showed. */
export function getStopScreen({ pageHost, pairing }: SignInScreen, view: 'refused' | 'done-no-opener'): SignInScreen {
  return { view, pageHost, failure: null, pairing };
}

/** What the window shows before its flow decides anything: it waits on its opener, or turned it away. */
export function getResponderScreen(state: ResponderState): SignInScreen {
  return { view: state.kind === 'refused' ? 'refused' : 'connecting', pageHost: null, failure: null, pairing: SPINNER };
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
    const account = session.uiState === null ? null : getOfferedAccount(parseUiStateCache(session.uiState));
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
