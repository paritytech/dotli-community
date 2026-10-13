// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { memoryStorage, resetAllStoresForTests } from '@dotli/shared/testing';
import { FakeColorScheme } from './testing/color-scheme.js';
import { createThemeController } from './theme-controller.js';
import { paintStoredTheme } from './theme-paint.js';

/** Page parts over `storage` and an OS on `scheme`, with the attributes set on the root. */
function page(storage: Pick<Storage, 'getItem' | 'setItem'>, scheme: 'light' | 'dark') {
  const root = new Map<string, string>();
  const os = new FakeColorScheme(scheme);
  return {
    root,
    deps: {
      storage: () => storage,
      colorScheme: () => os,
      root: () => ({
        setAttribute: (name: string, value: string) => {
          root.set(name, value);
        },
      }),
    },
  };
}

describe('paintStoredTheme', () => {
  it('As a returning dotli user, my stored theme is on the page before first paint', () => {
    // Given a stored Light choice on a dark OS
    const local = memoryStorage();
    local.setItem('dotli-theme', 'light');
    const { deps, root } = page(local, 'dark');

    // When the head script paints
    paintStoredTheme(deps);

    // Then
    expect(root.get('data-theme-pref')).toBe('light');
    expect(root.get('data-theme')).toBe('light');
  });

  it('As a dotli user whose browser blocks storage, the page paints the System option on the OS scheme', () => {
    // Given storage that throws on every access, on a light OS
    const blocked = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const { deps, root } = page({ getItem: blocked, setItem: blocked }, 'light');

    // When the head script paints
    paintStoredTheme(deps);

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('light');
  });

  it('As a dotli user, the theme painted before first paint is the one the page keeps once it boots', () => {
    for (const stored of [null, 'light', 'dark', 'system', 'sepia']) {
      for (const scheme of ['light', 'dark'] as const) {
        // Given a stored value, or none, on an OS scheme
        resetAllStoresForTests();
        const local = memoryStorage();
        if (stored !== null) {
          local.setItem('dotli-theme', stored);
        }
        const head = page(local, scheme);
        const boot = page(local, scheme);

        // When the head script paints, and the theme controller boots
        paintStoredTheme(head.deps);
        createThemeController(boot.deps).initTheme();

        // Then both set the same attributes
        expect(head.root, `${String(stored)} on a ${scheme} OS`).toEqual(boot.root);
      }
    }
  });
});
