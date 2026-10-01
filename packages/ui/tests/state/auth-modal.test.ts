// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { authModalStore, getAuthModalState, resetAuthModal, updateAuthModal } from '../../src/state/auth-modal.js';
import { resetStores } from '../helpers/solid.js';

describe('auth modal store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the auth modal, the store starts closed with the spinner and no labels', () => {
    expect(getAuthModalState()).toEqual({
      open: false,
      productLabel: null,
      reason: null,
      view: { kind: 'spinner' },
    });
  });

  it('As the auth controller, an update replaces only the given fields', () => {
    // Given
    updateAuthModal({ open: true, view: { kind: 'authenticating' } });

    // When
    updateAuthModal({
      productLabel: 'foo.dot',
      reason: 'Sign the transfer',
      view: { kind: 'spinner' },
    });

    // Then
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: 'foo.dot',
      reason: 'Sign the transfer',
      view: { kind: 'spinner' },
    });
  });

  it('As the auth modal, a view change keeps the rest and notifies once', () => {
    // Given
    const seen: string[] = [];
    const unsubscribe = authModalStore.subscribe(() => {
      seen.push(authModalStore.get().view.kind);
    });

    // When
    updateAuthModal({
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });

    // Then
    expect(seen).toEqual(['pairing']);
    expect(getAuthModalState().view).toEqual({
      kind: 'pairing',
      payload: 'polkadotapp://pair?x',
    });
    unsubscribe();
  });

  it('As the auth controller, reset closes and clears the presentation', () => {
    // Given
    updateAuthModal({ open: true, productLabel: 'foo.dot', reason: 'why' });

    // When
    resetAuthModal();

    // Then
    expect(getAuthModalState()).toEqual({
      open: false,
      productLabel: null,
      reason: null,
      view: { kind: 'spinner' },
    });
  });
});
