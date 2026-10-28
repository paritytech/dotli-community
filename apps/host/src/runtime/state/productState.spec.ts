// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { productState } from './productState.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('product store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user opening the page, I read the product state and see no product and no load yet', () => {
    // Given a page as it opens

    // When
    const state = productState.get();

    // Then
    expect(state).toEqual({ status: 'none', loadId: 0 });
  });

  it('As a user, I load a product from a CID and see its label, product id and CID', () => {
    // Given a page as it opens, with no product loaded

    // When
    productState.setLoaded({ label: 'myapp', productId: 'myapp.dot', details: { cid: 'bafyroot' } });

    // Then
    expect(productState.get()).toEqual({
      status: 'loaded',
      loadId: 1,
      label: 'myapp',
      productId: 'myapp.dot',
      cid: 'bafyroot',
    });
  });

  it('As a user, I reload the same product and every load is announced', () => {
    // Given
    productState.setLoaded({ label: 'myapp', productId: 'myapp.dot' });
    const seen: number[] = [];
    onTestFinished(
      productState.store.subscribe(() => {
        seen.push(productState.get().loadId);
      }),
    );

    // When
    productState.setLoaded({ label: 'myapp', productId: 'myapp.dot' });
    productState.setError();
    productState.setLoaded({ label: 'myapp', productId: 'myapp.dot' });

    // Then
    expect(seen).toEqual([2, 3, 4]);
    expect(productState.get()).toEqual({ status: 'loaded', loadId: 4, label: 'myapp', productId: 'myapp.dot' });
  });

  it('As a user, I hit a failed load and no product is left on show', () => {
    // Given
    productState.setLoaded({ label: 'myapp', productId: 'myapp.dot' });

    // When
    productState.setError();

    // Then
    expect(productState.get()).toEqual({ status: 'error', loadId: 2 });
  });
});
