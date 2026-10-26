// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createStoreStatus } from './createStoreStatus.js';
import { createSyncStore } from './createSyncStore.js';

describe('createStoreStatus', () => {
  it('As a layer above, I read the status and it is the value the store holds', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'idle' });
    const status = createStoreStatus(store);
    store.set('ready');

    // When
    const value = status.get();

    // Then
    expect(value).toBe('ready');
  });

  it('As a layer above, I subscribe and hear each new value of the store until I unsubscribe', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'idle' });
    const status = createStoreStatus(store);
    const heard: string[] = [];
    const unsubscribe = status.subscribe(value => {
      heard.push(value);
    });

    // When
    store.set('connecting');
    unsubscribe();
    store.set('ready');

    // Then
    expect(heard).toEqual(['connecting']);
  });
});
