// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseRecentLabels } from './parseRecentLabels.js';

describe('parseRecentLabels', () => {
  it.each([null, ''])('As a visitor with nothing stored (%j), I open the landing page and see no recent names', raw => {
    // When
    const labels = parseRecentLabels(raw);

    // Then
    expect(labels).toEqual([]);
  });

  it('As a visitor, I open the landing page and see the stored names in order', () => {
    // When
    const labels = parseRecentLabels('["myapp","test"]');

    // Then
    expect(labels).toEqual(['myapp', 'test']);
  });

  it('As a visitor with twelve stored names, I open the landing page and see at most eight', () => {
    // Given
    const stored = Array.from({ length: 12 }, (_, index) => `app${String(index)}`);

    // When
    const labels = parseRecentLabels(JSON.stringify(stored));

    // Then
    expect(labels).toHaveLength(8);
  });

  it.each(['not-json', '{"foo":"bar"}'])(
    'As a visitor whose stored entry is corrupt or foreign (%s), I open the landing page and see no recent names',
    raw => {
      // When
      const labels = parseRecentLabels(raw);

      // Then
      expect(labels).toEqual([]);
    },
  );

  it('As a visitor, I open the landing page and see the stored names in order, less one too short to be registered', () => {
    // When
    const labels = parseRecentLabels('["p","explore"]');

    // Then
    expect(labels).toEqual(['explore']);
  });
});
