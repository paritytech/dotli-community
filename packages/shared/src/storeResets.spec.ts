// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { registerStoreStateReset, resetAllStoresForTests } from './storeResets.js';

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
});
