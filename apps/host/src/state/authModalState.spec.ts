// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { authModalState } from './authModalState.js';
import { recordNotified } from '../testing/recordNotified.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('auth modal state', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user signing in, I see the sign-in modal take an update and keep every field it leaves out', () => {
    // Given
    authModalState.update({ open: true, view: { kind: 'authenticating' } });

    // When
    authModalState.update({
      productLabel: 'foo.dot',
      reason: 'Sign the transfer',
      view: { kind: 'spinner' },
    });

    // Then
    expect(authModalState.store.get()).toEqual({
      open: true,
      productLabel: 'foo.dot',
      reason: 'Sign the transfer',
      view: { kind: 'spinner' },
    });
  });

  it('As a user who finished signing in, I see the modal reset and close with its product and reason cleared', () => {
    // Given
    authModalState.update({ open: true, productLabel: 'foo.dot', reason: 'why' });

    // When
    authModalState.reset();

    // Then
    expect(authModalState.store.get()).toEqual({
      open: false,
      productLabel: null,
      reason: null,
      view: { kind: 'spinner' },
    });
  });

  it('As a user on the sign-in modal, I get the same fields and an equal view again and see no redraw', () => {
    // Given
    authModalState.update({
      open: true,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });
    const notified = recordNotified(authModalState.store);

    // When
    authModalState.update({ open: true });
    authModalState.update({
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });

    // Then
    expect(notified).toEqual([]);
  });

  it('As a user on the sign-in modal, I get a new view and two resets and see one redraw per change', () => {
    // Given
    authModalState.update({
      open: true,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });
    const notified = recordNotified(authModalState.store);

    // When
    authModalState.update({
      view: { kind: 'pairing', payload: 'polkadotapp://pair?y' },
    });
    authModalState.reset();
    authModalState.reset();

    // Then
    expect(notified.map(state => state.view)).toEqual([
      { kind: 'pairing', payload: 'polkadotapp://pair?y' },
      { kind: 'spinner' },
    ]);
  });
});
