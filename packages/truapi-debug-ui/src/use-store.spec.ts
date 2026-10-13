// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { describe, expect, it, vi } from 'vitest';
import { createEffect, createRoot, flush, type Accessor } from 'solid-js';
import { createSyncStore, type ReadableStore } from '@dotli/shared';
import { useStore } from './use-store.js';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

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
    captures.exception.mockClear();
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
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a caller outside any reactive owner, useStore throws instead of leaking a subscription', () => {
    // Given
    const store = createSyncStore('test', 'x');

    // When / Then
    expect(() => useStore(store)).toThrow('useStore must be called inside a component or reactive owner');
  });

  it('As a handler, the accessor still returns the old value right after a set, until the next flush, while store.get() is current', () => {
    // Given
    const store = createSyncStore('test', 1);
    const view = watch(store);
    flush();

    // When
    store.set(2);

    // Then
    expect(store.get()).toBe(2);
    expect(view.value()).toBe(1);

    // When
    flush();

    // Then
    expect(view.value()).toBe(2);
  });
});
