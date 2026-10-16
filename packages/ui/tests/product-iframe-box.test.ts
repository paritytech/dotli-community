// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { productIframeBox } from '../src/product-iframe-box.js';

// happy-dom drops any `var()` or `calc()` declaration, so the box is plain data and these tests check the declared
// values, not resolved pixels.

describe('product iframe box', () => {
  it('As a user on a notched phone, the product keeps clear of the topbar and of every display inset', () => {
    // Given
    const opts = { topbarOffset: true };

    // When
    const box = productIframeBox(opts);

    // Then
    expect(box.top).toBe('var(--content-top, 68px)');
    expect(box.left).toBe('var(--safe-left, 0px)');
    expect(box.width).toBe('calc(100% - var(--safe-left, 0px) - var(--safe-right, 0px))');
    expect(box.height).toBe('calc(100dvh - var(--content-top, 68px) - var(--content-bottom, 0px))');
  });

  it('As a user on a notched phone with the topbar hidden, the product still starts below the status bar', () => {
    // Given
    const opts = { topbarOffset: false };

    // When
    const box = productIframeBox(opts);

    // Then
    expect(box.top).toBe('var(--safe-top, 0px)');
    expect(box.height).toBe('calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px))');
  });

  it('As a user on a browser without env() support, every reserved inset falls back to zero', () => {
    // Given
    const box = productIframeBox({ topbarOffset: true });
    const values = [box.top, box.left, box.width, box.height];

    // When
    const tokens = values.flatMap(value => value.match(/var\(--[a-z-]+, [^)]+\)/g) ?? []);

    // Then
    // Without a fallback the whole declaration drops and the layout breaks, so
    // each token must name one. The topbar keeps its own 68px default, the desktop band.
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token).toMatch(/, (0px|68px)\)$/);
    }
  });
});
