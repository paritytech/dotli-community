// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createSyncStore, resetAllStoresForTests, shallowEqual } from './sync-store.js';

describe('createSyncStore', () => {
  it('As non-UI code, the getter returns the value just set', () => {
    // Given
    const store = createSyncStore<{ n: number }>('test', { n: 0 });

    // When
    store.set({ n: 1 });

    // Then
    expect(store.get()).toEqual({ n: 1 });
  });

  it('As a subscriber, I am notified synchronously after each set, and the getter is already current', () => {
    // Given
    const store = createSyncStore('test', 0);
    const seen: number[] = [];
    store.subscribe(() => {
      seen.push(store.get());
    });

    // When
    store.set(1);
    store.set(2);

    // Then
    expect(seen).toEqual([1, 2]);
  });

  it('As a subscriber, after unsubscribing I am no longer notified', () => {
    // Given
    const store = createSyncStore('test', 'a');
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    // When
    unsubscribe();
    store.set('b');

    // Then
    expect(listener).not.toHaveBeenCalled();
  });

  it('As a subscriber, unsubscribing during notify neither skips nor repeats other listeners', () => {
    // Given
    const store = createSyncStore('test', 0);
    const calls: string[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      calls.push('first');
      unsubscribeFirst();
    });
    store.subscribe(() => {
      calls.push('second');
    });

    // When
    store.set(1);
    store.set(2);

    // Then
    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('As a setter, a throwing listener is reported and the rest still run', () => {
    // Given
    const reported: Error[] = [];
    const store = createSyncStore('counter', 0, { onListenerError: error => reported.push(error) });
    const after = vi.fn();
    store.subscribe(() => {
      throw new Error('listener boom');
    });
    store.subscribe(after);

    // When
    store.set(1);

    // Then
    expect(store.get()).toBe(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toBe('store counter listener failed');
    expect(reported[0]?.cause).toEqual(expect.objectContaining({ message: 'listener boom' }));
  });

  it('As a test author, resetAllStoresForTests restores every store and notifies its subscribers', () => {
    // Given
    const a = createSyncStore('test', 'a');
    const b = createSyncStore<string[]>('test', []);
    const onA = vi.fn();
    a.subscribe(onA);
    a.set('changed');
    b.set(['x']);
    onA.mockClear();

    // When
    resetAllStoresForTests();

    // Then
    expect(a.get()).toBe('a');
    expect(b.get()).toEqual([]);
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it('As a producer, setting the value the store already holds notifies nobody', () => {
    // Given
    const value = { n: 1 };
    const store = createSyncStore('test', value);
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    store.set(value);
    store.set(value);

    // Then
    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.get()).toBe(value);
  });

  it('As a producer, a new object with equal contents still notifies under the default equality', () => {
    // Given
    const store = createSyncStore('test', { n: 1 });
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    store.set({ n: 1 });

    // Then
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('As a producer with shallow equality, rebuilding equal contents notifies nobody and keeps the old value', () => {
    // Given
    const first = { n: 1, s: 'a' };
    const store = createSyncStore('test', first, { equals: shallowEqual });
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    store.set({ n: 1, s: 'a' });
    store.set({ ...store.get() });

    // Then
    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.get()).toBe(first);

    // When
    store.set({ n: 2, s: 'a' });

    // Then
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ n: 2, s: 'a' });
  });

  it('As a producer with a custom equality, it decides which writes notify', () => {
    // Given
    const store = createSyncStore('test', { id: 1, label: 'a' }, { equals: (a, b) => a.id === b.id });
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    store.set({ id: 1, label: 'b' });
    store.set({ id: 2, label: 'b' });

    // Then
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ id: 2, label: 'b' });
  });

  it('As a test author, resetting a store that already holds its initial value notifies nobody', () => {
    // Given
    const store = createSyncStore('test', 'a');
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    resetAllStoresForTests();

    // Then
    expect(listener).toHaveBeenCalledTimes(0);
  });
});

describe('shallowEqual', () => {
  it('As a store, objects with the same keys and identical values are equal', () => {
    // Given
    const nested = { x: 1 };

    // When / Then
    expect(shallowEqual({ a: 1, b: nested }, { a: 1, b: nested })).toBe(true);
    expect(shallowEqual({ a: Number.NaN }, { a: Number.NaN })).toBe(true);
  });

  it('As a store, a changed value, an extra key or a nested copy makes objects differ', () => {
    // When / Then
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqual({ a: { x: 1 } }, { a: { x: 1 } })).toBe(false);
  });

  it('As a store, primitives and null compare with Object.is', () => {
    // When / Then
    expect(shallowEqual(1, 1)).toBe(true);
    expect(shallowEqual<unknown>(1, '1')).toBe(false);
    expect(shallowEqual<unknown>(null, {})).toBe(false);
    expect(shallowEqual(null, null)).toBe(true);
  });

  it('As a store, arrays with identical items are equal', () => {
    // Given
    const item = { id: 1 };

    // When / Then
    expect(shallowEqual([item, 2], [item, 2])).toBe(true);
    expect(shallowEqual([item], [item, 2])).toBe(false);
  });
});
