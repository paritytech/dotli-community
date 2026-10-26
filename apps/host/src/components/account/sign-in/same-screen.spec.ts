// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { AuthModalView } from '../../../state/auth-modal.js';
import { pairingPayload, sameSignInScreen } from './same-screen.js';

const SPINNER: AuthModalView = { kind: 'spinner' };
const PAIRING: AuthModalView = { kind: 'pairing', payload: 'polkadotapp://pair?handshake=a' };
const APPROVING: AuthModalView = { kind: 'authenticating' };

describe('the sign-in screen a view shows on', () => {
  it('As a phone user who chose to scan before the code came, I keep the pairing screen as it comes in', () => {
    // Given the code being made, and a new code that replaces the first
    const replacing: AuthModalView = { kind: 'pairing', payload: 'polkadotapp://pair?handshake=b' };

    // When the code arrives, and the new one replaces it
    const arrived = sameSignInScreen(SPINNER, PAIRING);
    const replaced = sameSignInScreen(PAIRING, replacing);

    // Then the pairing screen stays
    expect(arrived).toBe(true);
    expect(replaced).toBe(true);
  });

  it('As a user who scanned the code, I get a new screen to approve on', () => {
    // Given the code to scan
    const scanning = PAIRING;

    // When the phone asks me to approve, and a new code is then made
    const approving = sameSignInScreen(scanning, APPROVING);
    const restarting = sameSignInScreen(APPROVING, SPINNER);

    // Then each screen is built anew
    expect(approving).toBe(false);
    expect(restarting).toBe(false);
  });

  it('As a user shown another failure, I get a new screen, and the same failure keeps its screen', () => {
    // Given a failure on show
    const failure: AuthModalView = {
      kind: 'error',
      message: 'Rejected',
      retry: true,
      pending: false,
      title: 'Sign-in was declined',
      subtitle: 'Start again.',
    };

    // When an equal failure, and then another one, is written
    const equal = sameSignInScreen(failure, { ...failure });
    const other = sameSignInScreen(failure, { ...failure, title: 'Sign-in did not complete' });

    // Then only the other one builds a screen
    expect(equal).toBe(true);
    expect(other).toBe(false);
  });

  it('As a user waiting for the code, I see no payload until the code exists', () => {
    // Given a spinner, an approving view and a pairing view
    const views = [SPINNER, APPROVING, PAIRING];

    // When the payload is read from each
    const payloads = views.map(pairingPayload);

    // Then only the pairing view has one
    expect(payloads).toEqual([null, null, 'polkadotapp://pair?handshake=a']);
  });
});
