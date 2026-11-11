// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSafeStorage } from '@dotli/shared';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createPersistentAtom } from './createPersistentAtom.js';

function decodeNumber(raw: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof value === 'number' ? value : undefined;
}

function encodeNumber(value: number): string {
  return JSON.stringify(value);
}

function openBlocked(): Storage {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

function createCountingStorage(backing: Storage) {
  const storage = createSafeStorage(() => backing);
  let reads = 0;
  return {
    storage: {
      getItem(key: string) {
        reads += 1;
        return storage.getItem(key);
      },
      setItem: storage.setItem,
      removeItem: storage.removeItem,
    },
    countReads: () => reads,
  };
}

describe('createPersistentAtom', () => {
  it('As a page, I build a persistent atom and read the stored value', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const storage = createSafeStorage(() => backing);

    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    const value = count.get();

    // Then
    expect(value).toBe(7);
  });

  it('As a page with nothing stored, I read the initial value', () => {
    // Given
    const storage = createSafeStorage(() => createMemoryStorage());

    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 3,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    const value = count.get();

    // Then
    expect(value).toBe(3);
  });

  it.each([
    { stored: '"seven"', shape: 'has the wrong shape' },
    { stored: 'seven', shape: 'is not JSON' },
  ])('As a page whose stored value $shape, I read the initial value', ({ stored }) => {
    // Given
    const backing = createMemoryStorage({ entries: { count: stored } });
    const storage = createSafeStorage(() => backing);

    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 3,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    const value = count.get();

    // Then
    expect([value, backing.getItem('count')]).toEqual([3, stored]);
  });

  it('As a writer, I set a value and it is stored through my encode', () => {
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

  it('As a page whose storage throws on every call, I read the initial value, and set and get still work in memory', () => {
    // Given
    const storage = createSafeStorage(openBlocked);
    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 3,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    const first = count.get();
    count.set(5);

    // Then
    expect([first, count.get()]).toEqual([3, 5]);
  });

  it('As a page, I read the key before another tab writes it and keep my value until reload', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const storage = createSafeStorage(() => backing);
    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });
    count.get();

    // When
    backing.setItem('count', '99');
    const value = count.get();

    // Then
    expect(value).toBe(7);
  });

  it("As a page, I read the key after another tab wrote it before my first read and see that tab's value", () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const storage = createSafeStorage(() => backing);
    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    backing.setItem('count', '99');
    const value = count.get();

    // Then
    expect(value).toBe(99);
  });

  it('As a page that builds a persistent atom at import, I read no storage until something reads it', () => {
    // Given
    const { storage, countReads } = createCountingStorage(createMemoryStorage({ entries: { count: '7' } }));

    // When
    createPersistentAtom({ key: 'count', storage, initial: 0, decode: decodeNumber, encode: encodeNumber });

    // Then
    expect(countReads()).toBe(0);
  });

  it('As a page, I read a persistent atom twice and its storage once', () => {
    // Given
    const { storage, countReads } = createCountingStorage(createMemoryStorage({ entries: { count: '7' } }));
    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    const values = [count.get(), count.get()];

    // Then
    expect([values, countReads()]).toEqual([[7, 7], 1]);
  });

  it('As a writer who sets before anything read, I keep my value over the stored one, and setting the initial value then removes the key', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7' } });
    const { storage, countReads } = createCountingStorage(backing);
    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });

    // When
    count.set(9);
    const afterSet = [count.get(), backing.getItem('count'), countReads()];
    count.set(0);

    // Then
    expect([afterSet, backing.getItem('count')]).toEqual([[9, '9', 1], null]);
  });

  it('As a page, I start a persistent atom and the value it reads writes nothing back', () => {
    // Given
    const backing = createMemoryStorage({ entries: { count: '7.0' } });
    const storage = createSafeStorage(() => backing);
    const count = createPersistentAtom({
      key: 'count',
      storage,
      initial: 0,
      decode: decodeNumber,
      encode: encodeNumber,
    });
    const heard: number[] = [];

    // When
    count.listen(value => {
      heard.push(value);
    });

    // Then
    expect([count.get(), backing.getItem('count'), heard]).toEqual([7, '7.0', []]);
  });
});
