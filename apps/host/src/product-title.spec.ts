// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SITE_ID, withActiveTld } from '@dotli/config';

import { productTitle } from './product-title.js';

describe('product tab title', () => {
  it('As a dApp user, I open a named product and the tab shows its published name', () => {
    // When
    const title = productTitle({ mode: 'subdomain', label: 'doom', displayName: 'DOOM' });

    // Then
    expect(title).toBe('DOOM');
  });

  it('As a dApp user, I open a product with no published name and the tab shows its .dot name', () => {
    // When
    const title = productTitle({ mode: 'subdomain', label: 'doom' });

    // Then
    expect(title).toBe(withActiveTld('doom'));
  });

  it('As a developer, I open a local or preview product and the tab names its host and the site', () => {
    // When
    const title = productTitle({ mode: 'iframe', label: 'localhost:5199' });

    // Then
    expect(title).toBe(`localhost:5199 · ${SITE_ID}`);
  });
});
