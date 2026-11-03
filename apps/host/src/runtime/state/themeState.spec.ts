// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { themeState } from './themeState.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('theme store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user opening the prerendered page, I read the theme and get system/dark without a matchMedia read', () => {
    // Given a prerendered page as it opens

    // When
    const theme = themeState.get();

    // Then
    expect(theme).toEqual({ preference: 'system', resolved: 'dark' });
  });

  it('As a user, I pick the same theme twice and it is announced once', () => {
    // Given
    let heard = 0;
    onTestFinished(
      themeState.store.listen(() => {
        heard += 1;
      }),
    );

    // When
    themeState.set({ preference: 'light', resolved: 'light' });
    themeState.set({ preference: 'light', resolved: 'light' });

    // Then
    expect(heard).toBe(1);
    expect(themeState.get()).toEqual({ preference: 'light', resolved: 'light' });
  });
});
