// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createEffect, createMemo, createRoot, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createSyncStore, shallowEqual, type ReadableStore } from '../../src/state/create-store.js';
import { useStore } from '../../src/components/use-store.js';
import { renderComponent, settle } from '../helpers/solid.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../metrics/src/sentry.js', () => sentry);

function Label(props: { store: ReadableStore<string> }): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- the store object is fixed for the component's life; useStore tracks its value.
  const value = useStore(props.store);
  return <span class="label">{value()}</span>;
}

describe('useStore', () => {
  it("As a component, I render the store's value and re-render after it changes", async () => {
    // Given
    const store = createSyncStore('first');
    const view = renderComponent(() => <Label store={store} />);
    expect(view.container.querySelector('.label')?.textContent).toBe('first');

    // When
    store.set('second');
    await settle();

    // Then
    expect(view.container.querySelector('.label')?.textContent).toBe('second');
  });

  it('As a component, unmounting unsubscribes me from the store', async () => {
    // Given
    const store = createSyncStore('x');
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
    const view = renderComponent(() => <Label store={counted} />);
    await settle();
    expect(active).toBe(1);

    // When
    view.unmount();

    // Then
    expect(active).toBe(0);
  });

  it('As a component, a set issued right after render and before the first flush is reflected once settled', async () => {
    // Given
    const store = createSyncStore('first');
    const view = renderComponent(() => <Label store={store} />);

    // When
    store.set('second');
    await settle();

    // Then
    expect(view.container.querySelector('.label')?.textContent).toBe('second');
  });

  it('As a component, a set dispatched from an owned scope like createRoot still reaches my mirror signal', async () => {
    // Given
    sentry.captureException.mockClear();
    const store = createSyncStore('first');
    const view = renderComponent(() => <Label store={store} />);
    await settle();

    // When
    createRoot(dispose => {
      store.set('b');
      dispose();
    });
    await settle();

    // Then
    expect(view.container.querySelector('.label')?.textContent).toBe('b');
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a caller outside any reactive owner, useStore throws instead of leaking a subscription', () => {
    // Given
    const store = createSyncStore('x');

    // When / Then
    expect(() => useStore(store)).toThrow('useStore must be called inside a component or reactive owner');
  });

  it('As a component selecting one field, a write to another field re-runs none of my computations', async () => {
    // Given
    const store = createSyncStore({ a: 1, b: 1 });
    let memoRuns = 0;
    let effectRuns = 0;
    function A(): JSX.Element {
      const a = useStore(store, s => s.a);
      const doubled = createMemo(() => {
        memoRuns += 1;
        return a() * 2;
      });
      createEffect(a, () => {
        effectRuns += 1;
      });
      return <span class="a">{doubled()}</span>;
    }
    const view = renderComponent(() => <A />);
    await settle();
    const base = { memo: memoRuns, effect: effectRuns };

    // When: an unrelated field changes, then an equal copy is written.
    store.set({ ...store.get(), b: 2 });
    await settle();
    store.set({ ...store.get() });
    await settle();

    // Then
    expect(memoRuns - base.memo).toBe(0);
    expect(effectRuns - base.effect).toBe(0);

    // When
    store.set({ ...store.get(), a: 5 });
    await settle();

    // Then
    expect(memoRuns - base.memo).toBe(1);
    expect(effectRuns - base.effect).toBe(1);
    expect(view.container.querySelector('.a')?.textContent).toBe('10');
  });

  it('As a component selecting a derived object, an equality I pass drops rebuilt equal slices', async () => {
    // Given
    const store = createSyncStore({ a: 1, b: 1, c: 1 });
    let effectRuns = 0;
    function AB(): JSX.Element {
      const ab = useStore(store, s => ({ a: s.a, b: s.b }), shallowEqual);
      createEffect(ab, () => {
        effectRuns += 1;
      });
      return (
        <span class="ab">
          {ab().a}-{ab().b}
        </span>
      );
    }
    const view = renderComponent(() => <AB />);
    await settle();
    const base = effectRuns;

    // When
    store.set({ ...store.get(), c: 2 });
    await settle();

    // Then
    expect(effectRuns - base).toBe(0);

    // When
    store.set({ ...store.get(), b: 3 });
    await settle();

    // Then
    expect(effectRuns - base).toBe(1);
    expect(view.container.querySelector('.ab')?.textContent).toBe('1-3');
  });

  it('As a component selecting a field, my selector runs once per store write, however often I read', async () => {
    // Given
    const store = createSyncStore({ a: 1 });
    let selects = 0;
    let read: (() => number) | undefined;
    function R(): JSX.Element {
      const a = useStore(store, s => {
        selects += 1;
        return s.a;
      });
      read = a;
      return (
        <span>
          {a()}
          {a()}
        </span>
      );
    }
    renderComponent(() => <R />);
    await settle();
    const base = selects;

    // When
    store.set({ a: 2 });
    await settle();
    read?.();
    read?.();

    // Then
    expect(selects - base).toBe(1);
  });

  it('As a handler, the accessor still returns the old value right after a set, until the next flush, while store.get() is current', async () => {
    // Given
    const store = createSyncStore({ a: 1 });
    let read: (() => number) | undefined;
    function R(): JSX.Element {
      const a = useStore(store, s => s.a);
      read = a;
      return <span>{a()}</span>;
    }
    renderComponent(() => <R />);
    await settle();

    // When
    store.set({ a: 2 });

    // Then
    expect(store.get().a).toBe(2);
    expect(read?.()).toBe(1);

    // When
    flush();

    // Then
    expect(read?.()).toBe(2);
  });
});
