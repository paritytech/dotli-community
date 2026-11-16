// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { asProductId } from '@parity/truapi';
import { productState } from './productState.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('product store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user, I reload the same product and every load is announced', () => {
    // Given
    productState.setLoaded({ label: 'myapp', productId: asProductId('myapp.dot') });
    const seen: number[] = [];
    onTestFinished(
      productState.store.listen(() => {
        seen.push(productState.store.get().loadId);
      }),
    );

    // When
    productState.setLoaded({ label: 'myapp', productId: asProductId('myapp.dot') });
    productState.setError();
    productState.setLoaded({ label: 'myapp', productId: asProductId('myapp.dot') });

    // Then
    expect(seen).toEqual([2, 3, 4]);
    expect(productState.store.get()).toEqual({
      status: 'loaded',
      loadId: 4,
      label: 'myapp',
      productId: 'myapp.dot',
      facts: {},
    });
  });
});
