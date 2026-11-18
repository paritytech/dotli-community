// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { matchSuggestions } from './matchSuggestions.js';

describe('matchSuggestions', () => {
  it('As a visitor typing "al", I see alice before alpaca and only names starting with al', () => {
    // Given names that start with al and names that only hold it
    const apps = ['alpaca', 'bob', 'alice', 'pal'];

    // When the visitor types al
    const matches = matchSuggestions({ name: 'al', recents: [], apps });

    // Then the shorter alice comes first and the others are left out
    expect(matches.apps).toEqual(['alice', 'alpaca']);
  });

  it('As a visitor, I see at most 6 suggestions', () => {
    // Given eight names that start with a
    const apps = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];

    // When the visitor types a
    const matches = matchSuggestions({ name: 'a', recents: [], apps });

    // Then only the first six show
    expect(matches.apps).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('As a returning visitor with nothing typed, I see all my recents and no app labels', () => {
    // Given recents and apps
    const recents = ['bob', 'alice'];

    // When nothing is typed
    const matches = matchSuggestions({ name: '', recents, apps: ['alice', 'bob', 'carol'] });

    // Then every recent shows, in its order, and no app label
    expect(matches).toEqual({ recent: ['bob', 'alice'], apps: [] });
  });

  it('As a returning visitor typing a, I see my matching recents in order and the other matching app labels', () => {
    // Given recents newest first, one of them also an app
    const recents = ['avocado', 'banana', 'axe'];

    // When the visitor types a
    const matches = matchSuggestions({ name: 'a', recents, apps: ['ant', 'apple', 'avocado', 'banana'] });

    // Then the matching recents keep their order and the app that is a recent shows only under them
    expect(matches).toEqual({ recent: ['avocado', 'axe'], apps: ['ant', 'apple'] });
  });
});
