// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { createThemeSubscribe } from './createThemeSubscribe.js';
import { isShallowEqual } from '@dotli/shared';
import { atom, type WritableAtom } from 'nanostores';
import type { ThemeState } from '../state/themeState.js';
import { yielded } from '../../testing/fixtures.js';

describe('theme host callbacks', () => {
  it('As a product developer, I subscribe to the theme and get each change until I unsubscribe', async () => {
    // Given
    const theme = createTheme('dark');
    const subscribeTheme = createThemeSubscribe({ theme });
    const iterator = subscribeTheme()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const next = iterator.next();

    // When
    theme.set({ preference: 'light', resolved: 'light' });
    const changed = await next;
    await iterator.return?.();
    theme.set({ preference: 'dark', resolved: 'dark' });
    const afterReturn = await iterator.next();

    // Then
    expect([first, changed].map(step => yielded(step)._unsafeUnwrap())).toEqual([
      { name: { tag: 'Default' }, variant: 'Dark' },
      { name: { tag: 'Default' }, variant: 'Light' },
    ]);
    expect(afterReturn.done).toBe(true);
  });

  it('As a product developer, I follow the theme while a preference resolves to the same one and hear nothing new', async () => {
    // Given the OS is dark
    const theme = createTheme('dark');
    const iterator = createThemeSubscribe({ theme })()[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await iterator.return?.();
    });
    await iterator.next();
    const next = iterator.next();

    // When the user picks Dark, then Light
    theme.set({ preference: 'dark', resolved: 'dark' });
    theme.set({ preference: 'light', resolved: 'light' });
    const changed = await next;

    // Then the next item is Light, with nothing sent for Dark
    expect(yielded(changed)._unsafeUnwrap()).toEqual({ name: { tag: 'Default' }, variant: 'Light' });
  });
});

function createTheme(resolved: 'light' | 'dark'): WritableAtom<ThemeState> {
  const theme = atom<ThemeState>({ preference: 'system', resolved });
  theme.eq = isShallowEqual;
  return theme;
}
