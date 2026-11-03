// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createSyncStore, StoreListenerError } from './createSyncStore.js';
import { resetAllStoresForTests } from './storeResets.js';
import { isShallowEqual } from './isShallowEqual.js';

describe('createSyncStore', () => {
  it('As a follower, I am notified synchronously after each set, and the getter is already current', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 0 });
    const seen: number[] = [];
    store.listen(() => {
      seen.push(store.get());
    });

    // When
    store.set(1);
    store.set(2);

    // Then
    expect(seen).toEqual([1, 2]);
  });

  it('As a follower, I listen to a store and hear each change with its old value, and no first call', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 0 });
    const heard: [number, number | undefined][] = [];

    // When
    const unlisten = store.listen((value, oldValue) => {
      heard.push([value, oldValue]);
    });
    const heardOnListen = [...heard];
    store.set(1);
    store.set(1);
    store.set(2);
    unlisten();
    store.set(3);

    // Then
    expect(heardOnListen).toEqual([]);
    expect(heard).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('As a follower, I listen with one function twice and hold two subscriptions that each unlisten alone', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 0 });
    const listener = vi.fn();
    const unlistenFirst = store.listen(listener);
    store.listen(listener);

    // When
    store.set(1);
    unlistenFirst();
    store.set(2);

    // Then
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('As a reader, I read init and get the value the store was built with', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'built' });

    // When
    store.set('later');

    // Then
    expect(store.init).toBe('built');
  });

  it('As a follower, I unlisten and am no longer notified', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'a' });
    const listener = vi.fn();
    const unlisten = store.listen(listener);

    // When
    unlisten();
    store.set('b');

    // Then
    expect(listener).not.toHaveBeenCalled();
  });

  it('As a follower, I unlisten during a notify and the other listeners are neither skipped nor repeated', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 0 });
    const calls: string[] = [];
    const unlistenFirst = store.listen(() => {
      calls.push('first');
      unlistenFirst();
    });
    store.listen(() => {
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
    store.listen(() => {
      throw cause;
    });
    store.listen(after);

    // When
    store.set(1);

    // Then
    expect(store.get()).toBe(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(StoreListenerError);
    expect(reported[0]).toMatchObject({ store: 'topbar', message: 'store topbar listener failed', cause });
  });

  it('As a test author, I call resetAllStoresForTests and every store is restored, its listeners notified', () => {
    // Given
    const textStore = createSyncStore({ name: 'test', initial: 'a' });
    const listStore = createSyncStore<string[]>({ name: 'test', initial: [] });
    const onTextChange = vi.fn();
    textStore.listen(onTextChange);
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
    store.listen(listener);

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
    store.listen(listener);

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
    store.listen(listener);

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
    store.listen(listener);

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
    store.listen(listener);

    // When
    resetAllStoresForTests();

    // Then
    expect(listener).toHaveBeenCalledTimes(0);
  });
});
