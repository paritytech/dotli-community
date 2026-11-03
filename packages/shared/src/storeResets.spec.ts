// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { registerAtomReset, registerStoreStateReset, resetAllStoresForTests } from './storeResets.js';

describe('storeResets', () => {
  it('As a test, I register two resets and resetAllStoresForTests runs both in the order they were registered', () => {
    // Given
    const calls: string[] = [];
    registerStoreStateReset(() => calls.push('first'));
    registerStoreStateReset(() => calls.push('second'));

    // When
    resetAllStoresForTests();

    // Then
    expect(calls).toEqual(['first', 'second']);
  });

  it('As a test, I reset an atom-shaped store and it holds its initial value again', () => {
    // Given
    let value = 'initial';
    const store = {
      init: 'initial',
      set(next: string) {
        value = next;
      },
    };
    registerAtomReset(store);
    store.set('changed');

    // When
    resetAllStoresForTests();

    // Then
    expect(value).toBe('initial');
  });

  it('As a test, I mix atom and plain resets and they run in registration order', () => {
    // Given
    const calls: string[] = [];
    registerStoreStateReset(() => calls.push('plain'));
    registerAtomReset({ init: 'atom', set: next => calls.push(next) });

    // When
    resetAllStoresForTests();

    // Then
    expect(calls.slice(-2)).toEqual(['plain', 'atom']);
  });
});
