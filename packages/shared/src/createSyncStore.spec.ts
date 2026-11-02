// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createSyncStore, resetAllStoresForTests, StoreListenerError } from './createSyncStore.js';
import { isShallowEqual } from './isShallowEqual.js';

describe('createSyncStore', () => {
  it('As a subscriber, I am notified synchronously after each set, and the getter is already current', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 0 });
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

  it('As a subscriber, I unsubscribe and am no longer notified', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'a' });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    // When
    unsubscribe();
    store.set('b');

    // Then
    expect(listener).not.toHaveBeenCalled();
  });

  it('As a subscriber, I unsubscribe during a notify and the other listeners are neither skipped nor repeated', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 0 });
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

  it('As a setter, I set a value while a listener throws and the throw is reported while the rest still run', () => {
    // Given
    const reported: Error[] = [];
    const store = createSyncStore({ name: 'topbar', initial: 0, onListenerError: error => reported.push(error) });
    const after = vi.fn();
    const cause = new Error('listener boom');
    store.subscribe(() => {
      throw cause;
    });
    store.subscribe(after);

    // When
    store.set(1);

    // Then
    expect(store.get()).toBe(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(StoreListenerError);
    expect(reported[0]).toMatchObject({ store: 'topbar', message: 'store topbar listener failed', cause });
  });

  it('As a test author, I call resetAllStoresForTests and every store is restored, its subscribers notified', () => {
    // Given
    const textStore = createSyncStore({ name: 'test', initial: 'a' });
    const listStore = createSyncStore<string[]>({ name: 'test', initial: [] });
    const onTextChange = vi.fn();
    textStore.subscribe(onTextChange);
    textStore.set('changed');
    listStore.set(['x']);
    onTextChange.mockClear();

    // When
    resetAllStoresForTests();

    // Then
    expect(textStore.get()).toBe('a');
    expect(listStore.get()).toEqual([]);
    expect(onTextChange).toHaveBeenCalledTimes(1);
  });

  it('As a producer, I set the value the store already holds and nobody is notified', () => {
    // Given
    const value = { n: 1 };
    const store = createSyncStore({ name: 'test', initial: value });
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    store.set(value);
    store.set(value);

    // Then
    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.get()).toBe(value);
  });

  it('As a producer, I set a new object with equal contents and it still notifies under the default equality', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: { n: 1 } });
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    store.set({ n: 1 });

    // Then
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('As a producer with shallow equality, I rebuild equal contents and nobody is notified, the old value kept', () => {
    // Given
    const first = { n: 1, s: 'a' };
    const store = createSyncStore({ name: 'test', initial: first, equals: isShallowEqual });
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

  it('As a producer with a custom equality, I set values and the equality decides which writes notify', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: { id: 1, label: 'a' }, equals: (a, b) => a.id === b.id });
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    store.set({ id: 1, label: 'b' });
    store.set({ id: 2, label: 'b' });

    // Then
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ id: 2, label: 'b' });
  });

  it('As a test author, I reset a store that already holds its initial value and nobody is notified', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'a' });
    const listener = vi.fn();
    store.subscribe(listener);

    // When
    resetAllStoresForTests();

    // Then
    expect(listener).toHaveBeenCalledTimes(0);
  });
});
