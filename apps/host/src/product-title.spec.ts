// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { SITE_ID, withActiveTld } from '@dotli/config';
import { setActiveRootManifest } from '@dotli/host-runtime';

import { productTitle, showProductTitle } from './product-title.js';

const DOOM_ROOT = {
  schemaVersion: 1,
  displayName: 'DOOM',
  description: 'The game',
  icon: { cid: 'bafkreidoom', format: 'png' },
};

afterEach(() => {
  setActiveRootManifest(null);
});

describe('product tab title', () => {
  it('As a dApp user, I open a named product and the tab shows its published name', () => {
    // Given
    const product = { mode: 'subdomain', label: 'doom' } as const;

    // When
    const title = productTitle(product, 'DOOM');

    // Then
    expect(title).toBe('DOOM');
  });

  it('As a dApp user, I open a product with no published name and the tab shows its .dot name', () => {
    // Given
    const product = { mode: 'subdomain', label: 'doom' } as const;

    // When
    const title = productTitle(product, undefined);

    // Then
    expect(title).toBe(withActiveTld('doom'));
  });

  it('As a developer, I open a local or preview product and the tab names its host and the site', () => {
    // Given
    const product = { mode: 'iframe', label: 'localhost:5199' } as const;

    // When
    const title = productTitle(product, 'Ignored');

    // Then
    expect(title).toBe(`localhost:5199 · ${SITE_ID}`);
  });

  it('As a dApp user, I reopen a product after its manifest arrived and the tab keeps the published name', () => {
    // Given
    setActiveRootManifest(DOOM_ROOT);

    const titles: string[] = [];

    // When
    showProductTitle({ mode: 'subdomain', label: 'doom' }, title => {
      titles.push(title);
    });

    // Then
    expect(titles).toEqual(['DOOM']);
  });
});
