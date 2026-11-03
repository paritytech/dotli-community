// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createEffect, createMemo, createRoot, flush, type Accessor } from 'solid-js';
import { createSyncStore, isShallowEqual, type ReadableStore } from '@dotli/shared';
import { catchError } from '@dotli/shared/testing';
import { useStore } from './useStore.js';

describe('useStore', () => {
  it("As a component, I read the store's value and see it again after it changes", () => {
    // Given a component that has rendered the first value
    const store = createSyncStore({ name: 'test', initial: 'first' });
    const view = watch(store);
    flush();
    const seenFirst = [...view.seen];

    // When
    store.set('second');
    flush();

    // Then
    expect(seenFirst).toEqual(['first']);
    expect(view.seen).toEqual(['first', 'second']);
    expect(view.value()).toBe('second');
  });

  it('As a component, I am disposed and my subscription to the store ends', () => {
    // Given a component reading a store that counts its subscribers
    const store = createSyncStore({ name: 'test', initial: 'x' });
    let active = 0;
    const counted: ReadableStore<string> = {
      get: store.get,
      initial: store.initial,
      init: store.init,
      listen: store.listen,
      subscribe: listener => {
        active += 1;
        const off = store.subscribe(listener);
        return () => {
          active -= 1;
          off();
        };
      },
    };
    const view = watch(counted);
    flush();
    const activeWhileMounted = active;

    // When
    view.dispose();

    // Then
    expect(activeWhileMounted).toBe(1);
    expect(active).toBe(0);
  });

  it('As a component, I see a set issued right after setup and before the first flush once it settles', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'first' });
    const view = watch(store);

    // When
    store.set('second');
    flush();

    // Then
    expect(view.value()).toBe('second');
    expect(view.seen.at(-1)).toBe('second');
  });

  it('As a component, I get a set dispatched from an owned scope like createRoot and my mirror signal shows it', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'first' });
    const view = watch(store);
    flush();

    // When
    createRoot(dispose => {
      store.set('b');
      dispose();
    });
    flush();

    // Then
    expect(view.value()).toBe('b');
  });

  it('As a caller outside any reactive owner, I call useStore and it throws instead of leaking a subscription', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: 'x' });

    // When
    const error = catchError(() => useStore(store));

    // Then
    expect(error).toMatchObject({ message: 'useStore must be called inside a component or reactive owner' });
  });

  it('As a component selecting one field, I see a write to another field re-run none of my computations and one to mine re-run each once', () => {
    // Given a component that selects `a`, doubles it and watches it
    const store = createSyncStore({ name: 'test', initial: { a: 1, b: 1 } });
    let memoRuns = 0;
    let effectRuns = 0;
    const view = createOwned(() => {
      const selected = useStore(store, state => state.a);
      const doubled = createMemo(() => {
        memoRuns += 1;
        return selected() * 2;
      });
      createEffect(selected, () => {
        effectRuns += 1;
      });
      return { doubled };
    });
    flush();
    const base = { memo: memoRuns, effect: effectRuns };

    // When an unrelated field changes, an equal copy is written, then the selected field changes
    store.set({ ...store.get(), b: 2 });
    flush();
    store.set({ ...store.get() });
    flush();
    const afterOthers = { memo: memoRuns - base.memo, effect: effectRuns - base.effect };
    store.set({ ...store.get(), a: 5 });
    flush();

    // Then
    expect(afterOthers).toEqual({ memo: 0, effect: 0 });
    expect(memoRuns - base.memo).toBe(1);
    expect(effectRuns - base.effect).toBe(1);
    expect(view.doubled()).toBe(10);
  });

  it('As a component selecting a derived object, I pass an equality and it drops rebuilt equal slices', () => {
    // Given a component that selects a rebuilt object and watches it
    const store = createSyncStore({ name: 'test', initial: { a: 1, b: 1, c: 1 } });
    let effectRuns = 0;
    const view = createOwned(() => {
      const slice = useStore(store, state => ({ a: state.a, b: state.b }), { equals: isShallowEqual });
      createEffect(slice, () => {
        effectRuns += 1;
      });
      return { slice };
    });
    flush();
    const base = effectRuns;

    // When a field outside the slice changes, then one inside it
    store.set({ ...store.get(), c: 2 });
    flush();
    const afterOutside = effectRuns - base;
    store.set({ ...store.get(), b: 3 });
    flush();

    // Then
    expect(afterOutside).toBe(0);
    expect(effectRuns - base).toBe(1);
    expect(view.slice()).toEqual({ a: 1, b: 3 });
  });

  it('As a component selecting a field, I read it often and my selector runs once per store write', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: { a: 1 } });
    let selects = 0;
    const view = createOwned(() => {
      const selected = useStore(store, state => {
        selects += 1;
        return state.a;
      });
      createEffect(
        () => selected() + selected(),
        () => undefined,
      );
      return { selected };
    });
    flush();
    const base = selects;

    // When
    store.set({ a: 2 });
    flush();
    view.selected();
    view.selected();

    // Then
    expect(selects - base).toBe(1);
  });

  it('As a handler, I read the accessor right after a set and get the old value until the next flush, while store.get() is current', () => {
    // Given
    const store = createSyncStore({ name: 'test', initial: { a: 1 } });
    const view = createOwned(() => {
      const selected = useStore(store, state => state.a);
      createEffect(selected, () => undefined);
      return { selected };
    });
    flush();

    // When a set lands, read before and after the next flush
    store.set({ a: 2 });
    const storeBeforeFlush = store.get().a;
    const accessorBeforeFlush = view.selected();
    flush();

    // Then
    expect(storeBeforeFlush).toBe(2);
    expect(accessorBeforeFlush).toBe(1);
    expect(view.selected()).toBe(2);
  });
});

/** Runs `setup` under a fresh owner, as a component body would, and returns what it built with the disposer. */
function createOwned<T>(setup: () => T): T & { dispose: () => void } {
  return createRoot(dispose => ({ ...setup(), dispose }));
}

/** An owner that reads the store and records each value its effect sees, as a rendered label would. */
function watch<T>(store: ReadableStore<T>): { value: Accessor<T>; seen: T[]; dispose: () => void } {
  return createOwned(() => {
    const value = useStore(store);
    const seen: T[] = [];
    createEffect(value, next => {
      seen.push(next);
    });
    return { value, seen };
  });
}
