// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createThemeState } from './themeState.js';

describe('theme state', () => {
  it('As a user opening the prerendered page, I read the theme and get system/dark without a matchMedia read', () => {
    // Given a prerendered page as it opens
    const { store } = createThemeState({ storage: createMemoryStorage() });

    // When
    const theme = store.get();

    // Then
    expect(theme).toEqual({ preference: 'system', resolved: 'dark' });
  });

  it('As a user with Light chosen, I see the OS turn light and nobody is told', () => {
    // Given Light chosen on a dark OS
    const { store, selectPreference, showSystemScheme } = createThemeState({ storage: createMemoryStorage() });
    selectPreference('light');
    let heard = 0;
    onTestFinished(
      store.listen(() => {
        heard += 1;
      }),
    );

    // When the OS turns light
    showSystemScheme('light');

    // Then
    expect(heard).toBe(0);
    expect(store.get()).toEqual({ preference: 'light', resolved: 'light' });
  });

  it('As a returning user, I read the theme I chose in an earlier visit', () => {
    // Given Dark chosen in an earlier visit
    const { store } = createThemeState({ storage: createMemoryStorage({ entries: { 'dotli-theme': 'dark' } }) });

    // When
    const theme = store.get();

    // Then
    expect(theme).toEqual({ preference: 'dark', resolved: 'dark' });
  });
});
