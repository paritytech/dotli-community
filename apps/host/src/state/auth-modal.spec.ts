// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { ReadableStore } from '@dotli/shared';
import { authModalStore, resetAuthModal, updateAuthModal } from './auth-modal.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

function countNotifications<T>(store: ReadableStore<T>): {
  count: () => number;
  stop: () => void;
} {
  let count = 0;
  const stop = store.subscribe(() => {
    count += 1;
  });
  return { count: () => count, stop };
}

describe('auth modal store', () => {
  afterEach(() => {
    resetStores();
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
    expect(authModalStore.get()).toEqual({
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
    expect(authModalStore.get().view).toEqual({
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
    expect(authModalStore.get()).toEqual({
      open: false,
      productLabel: null,
      reason: null,
      view: { kind: 'spinner' },
    });
  });

  it('As the auth modal, rewriting the same fields and an equal view notifies nobody', () => {
    // Given
    updateAuthModal({
      open: true,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });
    const modal = countNotifications(authModalStore);

    // When
    updateAuthModal({ open: true });
    updateAuthModal({
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });

    // Then
    expect(modal.count()).toBe(0);

    // When
    updateAuthModal({
      view: { kind: 'pairing', payload: 'polkadotapp://pair?y' },
    });
    resetAuthModal();
    resetAuthModal();

    // Then
    expect(modal.count()).toBe(2);
    modal.stop();
  });
});
