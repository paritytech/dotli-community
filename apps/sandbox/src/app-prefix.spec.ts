// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { pathWithoutAppPrefix } from './app-prefix.js';

describe('pathWithoutAppPrefix', () => {
  it("As a product, my sub-page sees its own path, query and hash without the sandbox's app prefix", () => {
    // Given a sub-page the service worker served under the prefix
    const location = { pathname: '/dotli-app/docs/intro', search: '?tab=1', hash: '#top' };

    // When
    const path = pathWithoutAppPrefix(location, '/dotli-app');

    // Then
    expect(path).toBe('/docs/intro?tab=1#top');
  });

  it('As a product, my root under the prefix reads as the root path', () => {
    // Given
    const root = { pathname: '/dotli-app', search: '', hash: '' };

    // When
    const path = pathWithoutAppPrefix(root, '/dotli-app');

    // Then
    expect(path).toBe('/');
  });

  it('As a product, a path outside the prefix is left alone', () => {
    // Given
    const outside = { pathname: '/other', search: '', hash: '' };

    // When
    const path = pathWithoutAppPrefix(outside, '/dotli-app');

    // Then
    expect(path).toBeNull();
  });
});
