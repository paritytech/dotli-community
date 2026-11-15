// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { sortProducts } from './sortProducts.js';

describe('sortProducts()', () => {
  it('As a developer filtering the debug panel, I see the product chips in name order with the events without a product last', () => {
    // When
    const sorted = sortProducts([undefined, 'b.dot', 'a.dot']);

    // Then
    expect(sorted).toEqual(['a.dot', 'b.dot', undefined]);
  });
});
