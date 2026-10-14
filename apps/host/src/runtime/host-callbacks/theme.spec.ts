// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createThemeSubscribe } from './theme.js';
import { createSyncStore, shallowEqual } from '@dotli/shared';
import type { ThemeState } from '../state/theme.js';
import { yielded } from '../../testing/fixtures.js';

function themeOf(resolved: 'light' | 'dark'): ReturnType<typeof createSyncStore<ThemeState>> {
  return createSyncStore<ThemeState>('theme_test', { pref: 'system', resolved }, { equals: shallowEqual });
}

describe('theme host callbacks', () => {
  it('As a product, I subscribe to the theme and get the current one at once', async () => {
    // Given
    const subscribeTheme = createThemeSubscribe(themeOf('light'));

    // When
    const iterator = subscribeTheme()[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    // Then
    expect(first.done).toBe(false);
    expect(yielded(first)._unsafeUnwrap()).toEqual({
      name: { tag: 'Default' },
      variant: 'Light',
    });
  });

  it('As a product, I get each theme change until I unsubscribe', async () => {
    // Given
    const theme = themeOf('dark');
    const subscribeTheme = createThemeSubscribe(theme);
    const iterator = subscribeTheme()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const next = iterator.next();

    // When
    theme.set({ pref: 'light', resolved: 'light' });
    const changed = await next;
    await iterator.return?.();
    theme.set({ pref: 'dark', resolved: 'dark' });
    const afterReturn = await iterator.next();

    // Then
    expect(yielded(first)._unsafeUnwrap()).toEqual({ name: { tag: 'Default' }, variant: 'Dark' });
    expect(yielded(changed)._unsafeUnwrap()).toEqual({ name: { tag: 'Default' }, variant: 'Light' });
    expect(afterReturn.done).toBe(true);
  });

  it('As a product, a preference change that resolves to the same theme sends me nothing new', async () => {
    // Given: the OS is dark, and the user picks System then Dark.
    const theme = themeOf('dark');
    const iterator = createThemeSubscribe(theme)()[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    // When
    theme.set({ pref: 'dark', resolved: 'dark' });
    theme.set({ pref: 'light', resolved: 'light' });

    // Then
    expect(yielded(await next)._unsafeUnwrap()).toEqual({ name: { tag: 'Default' }, variant: 'Light' });
    await iterator.return?.();
  });
});
