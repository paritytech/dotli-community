// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { authState } from './authState.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

const CONNECTED = { tag: 'Connected', session: { connected: true } } as const;

describe('auth store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user opening the page, I see the session restoring and count as logged out', () => {
    // Given a page as it opens

    // When
    const state = authState.get();
    const loggedIn = authState.isLoggedIn();

    // Then
    expect(state).toEqual({ tag: 'Restoring' });
    expect(loggedIn).toBe(false);
  });

  it('As a user going through sign-in, I repeat an auth step and every repeat is announced', () => {
    // Given
    const step = { tag: 'Authenticating' } as const;
    authState.set(step);
    let heard = 0;
    onTestFinished(
      authState.store.listen(() => {
        heard += 1;
      }),
    );

    // When
    authState.set(step);
    authState.set(step);

    // Then
    expect(heard).toBe(2);
  });
});

describe('logged-in session', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user whose wallet connects, I reach Connected and am logged in', () => {
    // Given a page as it opens, not yet logged in

    // When
    authState.set(CONNECTED);

    // Then
    expect(authState.isLoggedIn()).toBe(true);
  });

  it.each([{ tag: 'Disconnected' }, { tag: 'Unreachable' }] as const)(
    'As a logged-in user, I reach $tag and am logged out',
    state => {
      // Given
      authState.set(CONNECTED);

      // When
      authState.set(state);

      // Then
      expect(authState.isLoggedIn()).toBe(false);
    },
  );

  it('As a logged-in user, I pair again and stay logged in through every login step', () => {
    // Given
    authState.set(CONNECTED);

    // When
    authState.set({ tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' });
    authState.set({ tag: 'Authenticating' });
    authState.set({ tag: 'LoginFailed', kind: 'Other', reason: 'declined' });

    // Then
    expect(authState.isLoggedIn()).toBe(true);
  });

  it('As a user, I change auth state and the session already matches each state announced', () => {
    // Given
    const seen: boolean[] = [];
    onTestFinished(
      authState.store.listen(() => {
        seen.push(authState.isLoggedIn());
      }),
    );

    // When
    authState.set(CONNECTED);
    authState.set({ tag: 'Disconnected' });

    // Then
    expect(seen).toEqual([true, false]);
  });

  it('As a logged-in user, I connect again and the session announces nothing new', () => {
    // Given
    authState.set(CONNECTED);
    let notified = 0;
    onTestFinished(
      authState.loggedInStore.listen(() => {
        notified += 1;
      }),
    );

    // When
    authState.set(CONNECTED);

    // Then
    expect(notified).toBe(0);
  });
});
