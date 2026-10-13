// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { getProductState, productStore, setProductError, setProductLoaded } from './product.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('product store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the topbar, I start with no product and no load yet', () => {
    // When / Then
    expect(getProductState()).toEqual({ status: 'none', loadId: 0 });
  });

  it('As the debug panel, I read a product loaded from a CID with its label, product id and CID', () => {
    // When
    setProductLoaded('myapp', 'myapp.dot', 'bafyroot');

    // Then
    expect(productStore.get()).toEqual({
      status: 'loaded',
      loadId: 1,
      label: 'myapp',
      productId: 'myapp.dot',
      cid: 'bafyroot',
    });
  });

  it('As the chat panel, I am told about every load, a reload of the same product included', () => {
    // Given
    setProductLoaded('myapp', 'myapp.dot');
    const seen: number[] = [];
    const stop = productStore.subscribe(() => {
      seen.push(productStore.get().loadId);
    });

    // When
    setProductLoaded('myapp', 'myapp.dot');
    setProductError();
    setProductLoaded('myapp', 'myapp.dot');

    // Then
    expect(seen).toEqual([2, 3, 4]);
    expect(getProductState()).toEqual({ status: 'loaded', loadId: 4, label: 'myapp', productId: 'myapp.dot' });
    stop();
  });

  it('As a permissions reader, a failed load leaves no product to read for', () => {
    // Given
    setProductLoaded('myapp', 'myapp.dot');

    // When
    setProductError();

    // Then
    expect(getProductState()).toEqual({ status: 'error', loadId: 2 });
  });
});
