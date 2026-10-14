// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { getThemeState, setTheme, themeStore } from './theme.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('theme store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the prerendered shell, the theme store defaults to system/dark without reading matchMedia', () => {
    // When / Then
    expect(getThemeState()).toEqual({ pref: 'system', resolved: 'dark' });
  });

  it('As the TrUAPI theme bridge, I subscribe to the store and hear setTheme once per change', () => {
    // Given
    let heard = 0;
    const stop = themeStore.subscribe(() => {
      heard += 1;
    });

    // When
    setTheme({ pref: 'light', resolved: 'light' });
    setTheme({ pref: 'light', resolved: 'light' });

    // Then
    expect(heard).toBe(1);
    expect(themeStore.get()).toEqual({ pref: 'light', resolved: 'light' });
    stop();
  });
});
