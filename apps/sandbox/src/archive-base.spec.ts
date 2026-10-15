// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { withArchiveBase } from './archive-base.js';

describe('withArchiveBase', () => {
  it("As a visitor opening a deep link, the product's relative assets resolve from its archive root", () => {
    // Given
    const html = '<html><head><title>x</title><script src="./assets/app.js"></script></head></html>';

    // When
    const written = withArchiveBase(html, '/docs/intro', '/');

    // Then
    expect(written).toBe(
      '<html><head><base href="/"><title>x</title><script src="./assets/app.js"></script></head></html>',
    );
  });

  it("As a visitor opening the product's root, its page is written as published", () => {
    // Given
    const html = '<html><head><title>x</title></head></html>';

    // When
    const written = withArchiveBase(html, '/', '/');

    // Then
    expect(written).toBe(html);
  });

  it('As a product that sets its own base, my page is written as published on a deep link too', () => {
    // Given
    const html = '<html><head><base href="/app/"><title>x</title></head></html>';

    // When
    const written = withArchiveBase(html, '/docs/intro', '/');

    // Then
    expect(written).toBe(html);
  });

  it('As a product whose head carries attributes, the base still lands first in it', () => {
    // Given
    const html = '<html><head lang="en"><title>x</title></head></html>';

    // When
    const written = withArchiveBase(html, '/docs/intro', '/');

    // Then
    expect(written).toBe('<html><head lang="en"><base href="/"><title>x</title></head></html>');
  });

  it('As a product page with no head, the base goes before everything', () => {
    // Given
    const html = '<script src="./a.js"></script>';

    // When
    const written = withArchiveBase(html, '/docs/intro', '/');

    // Then
    expect(written).toBe('<base href="/"><script src="./a.js"></script>');
  });
});
