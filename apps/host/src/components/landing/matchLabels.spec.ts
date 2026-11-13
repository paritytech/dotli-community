// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { matchLabels } from './matchLabels.js';

const SUFFIX = '.paseo';

describe('matchLabels', () => {
  it('As a visitor typing "al", I see alice before alpaca and only names starting with al', () => {
    // Given names that start with al and names that only hold it
    const labels = ['alpaca', 'bob', 'alice', 'pal'];

    // When the visitor types al
    const matches = matchLabels(labels, 'al', SUFFIX);

    // Then the shorter alice comes first and the others are left out
    expect(matches).toEqual(['alice', 'alpaca']);
  });

  it('As a visitor, I see at most 6 suggestions', () => {
    // Given eight names that start with a
    const labels = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];

    // When the visitor types a
    const matches = matchLabels(labels, 'a', SUFFIX);

    // Then only the first six show
    expect(matches).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('As a visitor with nothing typed, I see no suggestions', () => {
    // Given names in the list
    const labels = ['alice', 'bob'];

    // When the input holds only spaces
    const matches = matchLabels(labels, '  ', SUFFIX);

    // Then nothing shows
    expect(matches).toEqual([]);
  });

  it('As a visitor before my network is known, I see no suggestions', () => {
    // Given names in the list
    const labels = ['alice', 'bob'];

    // When the visitor types before the TLD is known
    const matches = matchLabels(labels, 'al', null);

    // Then nothing shows
    expect(matches).toEqual([]);
  });
});
