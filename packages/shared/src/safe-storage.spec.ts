// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { safeStorage } from './safe-storage.js';
import { memoryStorage } from './testing/memory-storage.js';

const blocked = (): Storage => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

describe('safeStorage', () => {
  it('As a page with storage, I write, read, remove and clear through it', () => {
    // Given
    const backing = memoryStorage({ kept: '1', dropped: '1' });
    const page = safeStorage(() => backing);

    // When
    page.setItem('theme', 'dark');
    page.removeItem('dropped');

    // Then
    expect(page.getItem('theme')).toBe('dark');
    expect(page.getItem('kept')).toBe('1');
    expect(page.getItem('dropped')).toBeNull();
    page.clear();
    expect(backing.length).toBe(0);
  });

  it('As a page whose browser blocks storage, I read nothing and my writes are dropped, with nothing thrown', () => {
    // Given
    const page = safeStorage(blocked);

    // When
    const use = (): string | null => {
      page.setItem('theme', 'dark');
      page.removeItem('theme');
      page.clear();
      return page.getItem('theme');
    };

    // Then
    expect(use).not.toThrow();
    expect(use()).toBeNull();
  });

  it('As a page whose storage refuses a write, as a full quota does, I keep what I could read', () => {
    // Given
    const full = Object.assign(memoryStorage({ theme: 'light' }), {
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    });
    const page = safeStorage(() => full);

    // When
    page.setItem('theme', 'dark');

    // Then
    expect(page.getItem('theme')).toBe('light');
  });
});
