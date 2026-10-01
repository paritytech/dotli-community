// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { getProductState, productStore, setProductError, setProductLoaded } from '../../src/state/product.js';
import { resetStores, settle } from '../helpers/solid.js';

describe('product store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the topbar, the product store starts with no product', () => {
    expect(getProductState()).toEqual({ status: 'none' });
  });

  it('As a listener of dotli:product-loaded, the detail is { label, productId } and the store is loaded', async () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener('dotli:product-loaded', listener);

    // When
    setProductLoaded('myapp', 'myapp.dot');
    await settle();

    // Then
    expect(details).toEqual([{ label: 'myapp', productId: 'myapp.dot' }]);
    expect(productStore.get()).toEqual({
      status: 'loaded',
      label: 'myapp',
      productId: 'myapp.dot',
    });
    window.removeEventListener('dotli:product-loaded', listener);
  });

  it('As the debug panel, a product loaded from a CID carries it in the store, not in the event', async () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener('dotli:product-loaded', listener);

    // When
    setProductLoaded('myapp', 'myapp.dot', 'bafyroot');
    await settle();

    // Then
    expect(productStore.get()).toEqual({ status: 'loaded', label: 'myapp', productId: 'myapp.dot', cid: 'bafyroot' });
    expect(details).toEqual([{ label: 'myapp', productId: 'myapp.dot' }]);
    window.removeEventListener('dotli:product-loaded', listener);
  });

  it('As a listener of dotli:product-error, the event fires with no detail and the store is in error', () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener('dotli:product-error', listener);

    // When
    setProductError();

    // Then
    expect(details).toEqual([null]);
    expect(getProductState()).toEqual({ status: 'error' });
    window.removeEventListener('dotli:product-error', listener);
  });
});
