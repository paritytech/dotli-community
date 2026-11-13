// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isCarFile } from './isCarFile.js';
import { createPackedSite } from './testing/createPackedSite.js';

describe('isCarFile', () => {
  it.each([
    ['an empty response', new Uint8Array(0)],
    ['an HTML page', new TextEncoder().encode('<!DOCTYPE html><html>')],
  ])('As a sandbox loading a product, I get %s and do not read it as a CAR archive', (_label, bytes) => {
    // When
    const result = isCarFile(bytes);

    // Then
    expect(result).toBe(false);
  });

  it('As a sandbox loading a product, I get a site packed as a CAR and read it as a CAR archive', () => {
    // Given
    const { car } = createPackedSite({ 'index.html': '<h1>hi</h1>' });

    // When
    const result = isCarFile(car);

    // Then
    expect(result).toBe(true);
  });
});
