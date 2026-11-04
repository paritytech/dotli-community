// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The UrlPillShield island against the page's real url-pill, product, product card and topbar layer stores. The view
// itself is tested by the UrlPillShield and VerificationShield story plays. The island reads the stores through wiring
// that fails silently, so this test pins it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { UrlPillShield } from '../../src/islands/UrlPillShield.js';
import { toProductId } from '../../src/runtime/createTruapiRuntimeConfig.js';
import { productState } from '../../src/runtime/state/productState.js';
import { productCardState } from '../../src/state/productCardState.js';
import { topbarSurfaces } from '../../src/state/topbarSurfaces.js';
import { urlPillState } from '../../src/state/urlPillState.js';

let unmount: (() => void) | undefined;

function mountIsland(): void {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.id = 'url-pill';
  document.body.append(pill);
  unmount = render(() => <UrlPillShield />, pill);
  flush();
}

afterEach(() => {
  unmount?.();
  unmount = undefined;
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('UrlPillShield island', () => {
  it('As a dApp user, I open a trusted product and the shield names its connection', () => {
    // Given a product pill set to trusted
    urlPillState.showProduct('app', '.dot.li');
    urlPillState.setVerificationShield('trusted');

    // When the island mounts
    mountIsland();

    // Then the shield carries the trusted state and its name
    const shield = document.querySelector<HTMLElement>('[role="img"][aria-label="Trusted connection"]');
    expect(shield?.dataset['state']).toBe('trusted');
  });

  it('As a dApp user, I open the product card from the pill and it keeps the auto-hiding bar up while it loads my author', async () => {
    // Given a product pill on a loaded product with a cid, and an author source that finds no owner
    const source = vi.fn(() => Promise.resolve({ kind: 'none' as const }));
    urlPillState.showProduct('app', '.dot.li');
    productState.setLoaded({ label: 'app', productId: asProductId(toProductId('app')), details: { cid: 'bafy' } });
    productCardState.setAuthorSource(source);
    mountIsland();

    // When the pill is pressed with Enter or Space, which a native button sends as a click of detail 0
    document.getElementById('url-pill')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    flush();

    // Then the product card opens, holds the bar and asks for the author once
    const isOpen = (): boolean => document.getElementById('product-card-tooltip')?.hasAttribute('data-open') === true;
    await waitForDom(isOpen);
    expect(isOpen()).toBe(true);
    expect(topbarSurfaces.isAnyOpen()).toBe(true);
    expect(source).toHaveBeenCalledOnce();

    // When Escape is pressed
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flush();

    // Then the card closes and the bar is free
    expect(isOpen()).toBe(false);
    expect(topbarSurfaces.isAnyOpen()).toBe(false);
  });
});
