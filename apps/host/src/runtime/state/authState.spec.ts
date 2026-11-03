// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { atom } from 'nanostores';
import { authState } from './authState.js';
import type { DotliAuthState } from '../session/types.js';
import { catchError, resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

const CONNECTED = { tag: 'Connected', session: { connected: true } } as const;

describe('auth store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user opening the page, I see the session restoring and count as logged out', () => {
    // Given a page as it opens

    // When
    const state = authState.store.get();
    const loggedIn = authState.loggedInStore.get();

    // Then
    expect(state).toEqual({ tag: 'Restoring' });
    expect(loggedIn).toBe(false);
  });

  it('As the auth controller, I hear two steps set in one listener round in order, each once', () => {
    // Given a store whose listener sets two steps in one round
    const trigger = atom(0);
    onTestFinished(
      trigger.listen(() => {
        authState.set({ tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' });
        authState.set({ tag: 'Authenticating' });
      }),
    );
    const heard: DotliAuthState['tag'][] = [];
    onTestFinished(
      authState.subscribeSteps(step => {
        heard.push(step.tag);
      }),
    );

    // When
    trigger.set(1);

    // Then
    expect(heard).toEqual(['Pairing', 'Authenticating']);
  });

  it('As the auth controller, I hear a step whose store listener threw, and the writer gets the throw', () => {
    // Given a store listener that throws and a step listener
    const boom = new Error('listener failed');
    onTestFinished(
      authState.store.listen(step => {
        // Only the step under test throws, so the reset after the test does not
        if (step.tag === 'Authenticating') {
          throw boom;
        }
      }),
    );
    const heard: DotliAuthState['tag'][] = [];
    onTestFinished(
      authState.subscribeSteps(step => {
        heard.push(step.tag);
      }),
    );

    // When
    const thrown = catchError(() => {
      authState.set({ tag: 'Authenticating' });
    });

    // Then
    expect(thrown).toBe(boom);
    expect(heard).toEqual(['Authenticating']);
  });

  it('As the auth controller, I hear a repeated LoginFailed twice', () => {
    // Given
    const failed = { tag: 'LoginFailed', kind: 'Other', reason: 'declined' } as const;
    const heard: DotliAuthState[] = [];
    onTestFinished(
      authState.subscribeSteps(step => {
        heard.push(step);
      }),
    );

    // When
    authState.set(failed);
    authState.set(failed);

    // Then
    expect(heard).toEqual([failed, failed]);
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
    expect(authState.loggedInStore.get()).toBe(true);
  });

  it.each([{ tag: 'Disconnected' }, { tag: 'Unreachable' }] as const)(
    'As a logged-in user, I reach $tag and am logged out',
    state => {
      // Given
      authState.set(CONNECTED);

      // When
      authState.set(state);

      // Then
      expect(authState.loggedInStore.get()).toBe(false);
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
    expect(authState.loggedInStore.get()).toBe(true);
  });

  it('As a user, I change auth state and the session already matches each state announced', () => {
    // Given
    const seen: boolean[] = [];
    onTestFinished(
      authState.store.listen(() => {
        seen.push(authState.loggedInStore.get());
      }),
    );

    // When
    authState.set(CONNECTED);
    authState.set({ tag: 'Disconnected' });

    // Then
    expect(seen).toEqual([true, false]);
  });

  it('As an auth store follower, I hear each distinct step and the session already matches the step I hear', () => {
    // Given a follower that reads the session as it hears each step
    const failed = { tag: 'LoginFailed', kind: 'Other', reason: 'declined' } as const;
    const heard: { step: string; loggedIn: boolean }[] = [];
    onTestFinished(
      authState.store.listen(step => {
        heard.push({ step: step.tag, loggedIn: authState.loggedInStore.get() });
      }),
    );

    // When the user signs in, pairs again, fails and is signed out
    authState.set(CONNECTED);
    authState.set({ tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' });
    authState.set(failed);
    authState.set({ tag: 'Disconnected' });

    // Then every step reached the follower with the session it brings
    expect(heard).toEqual([
      { step: 'Connected', loggedIn: true },
      { step: 'Pairing', loggedIn: true },
      { step: 'LoginFailed', loggedIn: true },
      { step: 'Disconnected', loggedIn: false },
    ]);
  });

  it('As a logged-in follower, I hear the change after the step that caused it', () => {
    // Given a follower of the session that reads the auth step as it hears each change
    const heard: { loggedIn: boolean; step: string }[] = [];
    onTestFinished(
      authState.loggedInStore.listen(loggedIn => {
        heard.push({ loggedIn, step: authState.store.get().tag });
      }),
    );

    // When the user signs in, pairs again and is signed out
    authState.set(CONNECTED);
    authState.set({ tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' });
    authState.set({ tag: 'Disconnected' });

    // Then each change came with the step that caused it already current, and pairing again changed nothing
    expect(heard).toEqual([
      { loggedIn: true, step: 'Connected' },
      { loggedIn: false, step: 'Disconnected' },
    ]);
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
