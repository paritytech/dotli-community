// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createEffect, createMemo, createRoot, flush, type Accessor } from 'solid-js';
import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';
import { useStore } from './use-store.js';

/** Runs `setup` under a fresh owner, as a component body would, and returns what it built with the disposer. */
function owned<T>(setup: () => T): T & { dispose: () => void } {
  return createRoot(dispose => ({ ...setup(), dispose }));
}

/** An owner that reads the store and records each value its effect sees, as a rendered label would. */
function watch<T>(store: ReadableStore<T>): { value: Accessor<T>; seen: T[]; dispose: () => void } {
  return owned(() => {
    const value = useStore(store);
    const seen: T[] = [];
    createEffect(value, next => {
      seen.push(next);
    });
    return { value, seen };
  });
}

describe('useStore', () => {
  it("As a component, I read the store's value and see it again after it changes", () => {
    // Given
    const store = createSyncStore('test', 'first');
    const view = watch(store);
    flush();
    expect(view.seen).toEqual(['first']);

    // When
    store.set('second');
    flush();

    // Then
    expect(view.seen).toEqual(['first', 'second']);
    expect(view.value()).toBe('second');
  });

  it('As a component, disposal unsubscribes me from the store', () => {
    // Given
    const store = createSyncStore('test', 'x');
    let active = 0;
    const counted: ReadableStore<string> = {
      get: store.get,
      initial: store.initial,
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
    expect(active).toBe(1);

    // When
    view.dispose();

    // Then
    expect(active).toBe(0);
  });

  it('As a component, a set issued right after setup and before the first flush is reflected once settled', () => {
    // Given
    const store = createSyncStore('test', 'first');
    const view = watch(store);

    // When
    store.set('second');
    flush();

    // Then
    expect(view.value()).toBe('second');
    expect(view.seen.at(-1)).toBe('second');
  });

  it('As a component, a set dispatched from an owned scope like createRoot still reaches my mirror signal', () => {
    // Given
    const store = createSyncStore('test', 'first');
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

  it('As a caller outside any reactive owner, useStore throws instead of leaking a subscription', () => {
    // Given
    const store = createSyncStore('test', 'x');

    // When / Then
    expect(() => useStore(store)).toThrow('useStore must be called inside a component or reactive owner');
  });

  it('As a component selecting one field, a write to another field re-runs none of my computations', () => {
    // Given
    const store = createSyncStore('test', { a: 1, b: 1 });
    let memoRuns = 0;
    let effectRuns = 0;
    const view = owned(() => {
      const a = useStore(store, s => s.a);
      const doubled = createMemo(() => {
        memoRuns += 1;
        return a() * 2;
      });
      createEffect(a, () => {
        effectRuns += 1;
      });
      return { doubled };
    });
    flush();
    const base = { memo: memoRuns, effect: effectRuns };

    // When: an unrelated field changes, then an equal copy is written.
    store.set({ ...store.get(), b: 2 });
    flush();
    store.set({ ...store.get() });
    flush();

    // Then
    expect(memoRuns - base.memo).toBe(0);
    expect(effectRuns - base.effect).toBe(0);

    // When
    store.set({ ...store.get(), a: 5 });
    flush();

    // Then
    expect(memoRuns - base.memo).toBe(1);
    expect(effectRuns - base.effect).toBe(1);
    expect(view.doubled()).toBe(10);
  });

  it('As a component selecting a derived object, an equality I pass drops rebuilt equal slices', () => {
    // Given
    const store = createSyncStore('test', { a: 1, b: 1, c: 1 });
    let effectRuns = 0;
    const view = owned(() => {
      const ab = useStore(store, s => ({ a: s.a, b: s.b }), shallowEqual);
      createEffect(ab, () => {
        effectRuns += 1;
      });
      return { ab };
    });
    flush();
    const base = effectRuns;

    // When
    store.set({ ...store.get(), c: 2 });
    flush();

    // Then
    expect(effectRuns - base).toBe(0);

    // When
    store.set({ ...store.get(), b: 3 });
    flush();

    // Then
    expect(effectRuns - base).toBe(1);
    expect(view.ab()).toEqual({ a: 1, b: 3 });
  });

  it('As a component selecting a field, my selector runs once per store write, however often I read', () => {
    // Given
    const store = createSyncStore('test', { a: 1 });
    let selects = 0;
    const view = owned(() => {
      const a = useStore(store, s => {
        selects += 1;
        return s.a;
      });
      createEffect(
        () => a() + a(),
        () => undefined,
      );
      return { a };
    });
    flush();
    const base = selects;

    // When
    store.set({ a: 2 });
    flush();
    view.a();
    view.a();

    // Then
    expect(selects - base).toBe(1);
  });

  it('As a handler, the accessor still returns the old value right after a set, until the next flush, while store.get() is current', () => {
    // Given
    const store = createSyncStore('test', { a: 1 });
    const view = owned(() => {
      const a = useStore(store, s => s.a);
      createEffect(a, () => undefined);
      return { a };
    });
    flush();

    // When
    store.set({ a: 2 });

    // Then
    expect(store.get().a).toBe(2);
    expect(view.a()).toBe(1);

    // When
    flush();

    // Then
    expect(view.a()).toBe(2);
  });
});
