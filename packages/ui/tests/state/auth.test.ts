// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authStore,
  getAuthState,
  getLoggedIn,
  loggedInStore,
  setAuthState,
  setLoggedIn,
} from '../../src/state/auth.js';
import { dispatchAuthState } from '../../src/host-callbacks/AuthState.js';
import { resetStores, settle } from '../helpers/solid.js';

describe('auth store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the topbar, the auth store starts Disconnected and logged out', () => {
    // Then
    expect(getAuthState()).toEqual({ tag: 'Disconnected' });
    expect(getLoggedIn()).toBe(false);
  });

  it('As a listener of dotli:truapi-auth-state, the event carries the same detail and the store already holds it', async () => {
    // Given
    const seen: { detail: unknown; storeTag: string }[] = [];
    const listener = (e: Event): void => {
      seen.push({
        detail: (e as CustomEvent).detail,
        storeTag: getAuthState().tag,
      });
    };
    window.addEventListener('dotli:truapi-auth-state', listener);

    // When
    setAuthState({ tag: 'Authenticating' });
    await settle();

    // Then
    expect(seen).toEqual([{ detail: { tag: 'Authenticating' }, storeTag: 'Authenticating' }]);
    expect(authStore.get()).toEqual({ tag: 'Authenticating' });
    window.removeEventListener('dotli:truapi-auth-state', listener);
  });

  it('As the TrUAPI host callback, dispatchAuthState writes through the store', () => {
    // When
    dispatchAuthState({ tag: 'Authenticating' });

    // Then
    expect(getAuthState()).toEqual({ tag: 'Authenticating' });
  });

  it('As a listener, setLoggedIn fires dotli:authenticated and dotli:logged-out exactly as before', async () => {
    // Given
    const events: string[] = [];
    const onAuth = vi.fn(() => events.push('authenticated'));
    const onOut = vi.fn(() => events.push('logged-out'));
    window.addEventListener('dotli:authenticated', onAuth);
    window.addEventListener('dotli:logged-out', onOut);

    // When
    setLoggedIn(true);
    setLoggedIn(false);
    await settle();

    // Then
    expect(events).toEqual(['authenticated', 'logged-out']);
    expect(loggedInStore.get()).toBe(false);
    window.removeEventListener('dotli:authenticated', onAuth);
    window.removeEventListener('dotli:logged-out', onOut);
  });

  it('As a component, my store listener runs before dotli:truapi-auth-state is dispatched', () => {
    // Given
    const order: string[] = [];
    const unsubscribe = authStore.subscribe(() => order.push('listener'));
    const onEvent = (): void => {
      order.push('event');
    };
    window.addEventListener('dotli:truapi-auth-state', onEvent);

    // When
    setAuthState({ tag: 'Authenticating' });

    // Then
    expect(order).toEqual(['listener', 'event']);
    unsubscribe();
    window.removeEventListener('dotli:truapi-auth-state', onEvent);
  });
});
