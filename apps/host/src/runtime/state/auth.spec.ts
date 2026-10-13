// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { authStore, getAuthState, getLoggedIn, loggedInStore, setAuthState } from './auth.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

const CONNECTED = { tag: 'Connected', session: { connected: true } } as const;

describe('auth store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the topbar, the auth store starts Restoring, not yet signed in or out, and logged out', () => {
    // Then
    expect(getAuthState()).toEqual({ tag: 'Restoring' });
    expect(getLoggedIn()).toBe(false);
  });

  it('As the auth controller, every auth step notifies, even the same object again', () => {
    // Given
    const step = { tag: 'Authenticating' } as const;
    setAuthState(step);
    let heard = 0;
    const stop = authStore.subscribe(() => {
      heard += 1;
    });

    // When
    setAuthState(step);
    setAuthState(step);

    // Then
    expect(heard).toBe(2);
    stop();
  });
});

describe('logged-in session', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user whose wallet connects, I am logged in', () => {
    // When
    setAuthState(CONNECTED);

    // Then
    expect(getLoggedIn()).toBe(true);
  });

  it.each([{ tag: 'Disconnected' }, { tag: 'Unreachable' }] as const)(
    'As a logged-in user, $tag logs me out',
    state => {
      // Given
      setAuthState(CONNECTED);

      // When
      setAuthState(state);

      // Then
      expect(getLoggedIn()).toBe(false);
    },
  );

  it('As a logged-in user who pairs again, I stay logged in through every login step', () => {
    // Given
    setAuthState(CONNECTED);

    // When
    setAuthState({ tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' });
    setAuthState({ tag: 'Authenticating' });
    setAuthState({ tag: 'LoginFailed', kind: 'Other', reason: 'declined' });

    // Then
    expect(getLoggedIn()).toBe(true);
  });

  it('As a listener of the auth store, the session already matches the state I am told about', () => {
    // Given
    const seen: boolean[] = [];
    const unsubscribe = authStore.subscribe(() => {
      seen.push(getLoggedIn());
    });

    // When
    setAuthState(CONNECTED);
    setAuthState({ tag: 'Disconnected' });

    // Then
    expect(seen).toEqual([true, false]);
    unsubscribe();
  });

  it('As a session listener, a repeated Connected tells me nothing new', () => {
    // Given
    setAuthState(CONNECTED);
    let notified = 0;
    const unsubscribe = loggedInStore.subscribe(() => {
      notified += 1;
    });

    // When
    setAuthState(CONNECTED);

    // Then
    expect(notified).toBe(0);
    unsubscribe();
  });
});
