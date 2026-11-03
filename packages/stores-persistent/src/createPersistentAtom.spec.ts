// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSafeStorage } from '@dotli/shared';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createPersistentAtom } from './createPersistentAtom.js';

function decodeNumber(raw: string): number | undefined {
  const value: unknown = JSON.parse(raw);
  return typeof value === 'number' ? value : undefined;
}

function openBlocked(): Storage {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

describe('createPersistentAtom', () => {
  it('As a page, I build a persistent atom and read the stored value', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const storage = createSafeStorage(() => backing);

    // When
    const count = createPersistentAtom({ key: 'count', storage, initial: 0, decode: decodeNumber });

    // Then
    expect(count.get()).toBe(7);
  });

  it('As a page with nothing stored, I read the initial value', () => {
    // Given
    const storage = createSafeStorage(() => createMemoryStorage());

    // When
    const count = createPersistentAtom({ key: 'count', storage, initial: 3, decode: decodeNumber });

    // Then
    expect(count.get()).toBe(3);
  });

  it('As a page with a stored value that no longer parses, I read the initial value', () => {
    // Given
    const storage = createSafeStorage(() => createMemoryStorage({ entries: { count: '"seven"' } }));

    // When
    const count = createPersistentAtom({ key: 'count', storage, initial: 3, decode: decodeNumber });

    // Then
    expect(count.get()).toBe(3);
  });

  it('As a writer, I set a value and it is stored as JSON', () => {
    // Given
    const backing = createMemoryStorage();
    const storage = createSafeStorage(() => backing);
    const count = createPersistentAtom({ key: 'count', storage, initial: 0, decode: decodeNumber });

    // When
    count.set(9);

    // Then
    expect(backing.getItem('count')).toBe('9');
  });

  it('As a writer with my own encode, I set a value and it is stored encoded by it', () => {
    // Given
    const backing = createMemoryStorage();
    const storage = createSafeStorage(() => backing);
    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: value => `n${String(value)}`,
    });

    // When
    count.set(9);

    // Then
    expect(backing.getItem('count')).toBe('n9');
  });

  it('As a writer, I set the initial value and the key is removed', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const storage = createSafeStorage(() => backing);
    const count = createPersistentAtom({ key: 'count', storage, initial: 0, decode: decodeNumber });

    // When
    count.set(0);

    // Then
    expect(backing.getItem('count')).toBeNull();
  });

  it('As a page whose storage throws on every call, I read the initial value, and set and get still work in memory', () => {
    // Given
    const storage = createSafeStorage(openBlocked);
    const count = createPersistentAtom({ key: 'count', storage, initial: 3, decode: decodeNumber });

    // When
    const first = count.get();
    count.set(5);

    // Then
    expect([first, count.get()]).toEqual([3, 5]);
  });

  it('As a page, another tab writes the key and I keep my value until reload', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const storage = createSafeStorage(() => backing);
    const count = createPersistentAtom({ key: 'count', storage, initial: 0, decode: decodeNumber });

    // When
    backing.setItem('count', '99');

    // Then
    expect(count.get()).toBe(7);
  });
});
