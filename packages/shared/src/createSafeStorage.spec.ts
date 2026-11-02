// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSafeStorage } from './createSafeStorage.js';
import { createMemoryStorage } from './testing/createMemoryStorage.js';

function openBlocked(): Storage {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

describe('createSafeStorage', () => {
  it('As a page with storage, I write, remove and clear keys and read back what each step left', () => {
    // Given
    const backing = createMemoryStorage({ entries: { kept: '1', dropped: '1' } });
    const page = createSafeStorage(() => backing);

    // When
    page.setItem('theme', 'dark');
    page.removeItem('dropped');
    const read = [page.getItem('theme'), page.getItem('kept'), page.getItem('dropped')];
    page.clear();

    // Then
    expect(read).toEqual(['dark', '1', null]);
    expect(backing.length).toBe(0);
  });

  it('As a page whose browser blocks storage, I write and read with nothing thrown and read nothing back', () => {
    // Given
    const page = createSafeStorage(openBlocked);

    // When
    page.setItem('theme', 'dark');
    page.removeItem('theme');
    page.clear();
    const read = page.getItem('theme');
    const keys = page.keys();

    // Then
    expect(read).toBeNull();
    expect(keys).toEqual([]);
  });

  it('As a page whose storage refuses a write, as a full quota does, I write and still read what was stored before', () => {
    // Given
    const full = Object.assign(createMemoryStorage({ entries: { theme: 'light' } }), {
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    });
    const page = createSafeStorage(() => full);

    // When
    page.setItem('theme', 'dark');
    const read = page.getItem('theme');

    // Then
    expect(read).toBe('light');
  });
});
