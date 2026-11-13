// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ProductButton island against the page's real stores. The view itself is tested by its story play.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { ProductButton } from '../../src/islands/ProductButton.js';
import { toProductId } from '../../src/runtime/getAskedProductId.js';
import { productState } from '../../src/runtime/state/productState.js';
import { productCardState } from '../../src/state/productCardState.js';
import { topbarSurfaces } from '../../src/state/topbarSurfaces.js';
import { urlPillState } from '../../src/state/urlPillState.js';

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('ProductButton island', () => {
  it("As a phone user, I tap my product's icon and its card opens while my author loads, keeping the bar up", async () => {
    // Given the island mounted before any product state, then a product pill on a loaded product with a cid and an
    // author source that finds no owner
    const source = vi.fn(() => Promise.resolve({ kind: 'none' as const }));
    const host = document.createElement('div');
    document.body.append(host);
    unmount = render(() => <ProductButton />, host);
    flush();
    urlPillState.showProduct('app', '.dot.li');
    productState.setLoaded({ label: 'app', productId: asProductId(toProductId('app')), details: { cid: 'bafy' } });
    productCardState.setAuthorSource(source);
    flush();
    // and no author asked for before the button is pressed
    expect(source).not.toHaveBeenCalled();

    // When the product button is clicked
    document.getElementById('product-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    flush();

    // Then the sheet opens with the product card, holds the bar and asks for the author once
    const isOpen = (): boolean => document.getElementById('product-sheet')?.hasAttribute('data-open') === true;
    const hasCard = (): boolean => document.querySelector('[data-testid="product-card"]') !== null;
    await waitForDom(() => isOpen() && hasCard());
    expect(isOpen()).toBe(true);
    expect(hasCard()).toBe(true);
    expect(topbarSurfaces.isAnyOpen()).toBe(true);
    expect(source).toHaveBeenCalledOnce();
  });
});
