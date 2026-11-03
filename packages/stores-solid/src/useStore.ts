// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';
import type { ReadableAtom } from 'nanostores';

/** A store `useStore` reads: a nanostores store, or anything with its `get`, `listen` and `init`. */
export type StoreSource<Value> = Pick<ReadableAtom<Value>, 'get' | 'listen'> & {
  readonly init?: Value | undefined;
};

export type UseStoreParams<Value, Selected> = {
  /** Whether two selected values count as the same, so the accessor keeps the first. */
  equals?: ((previous: Selected, next: Selected) => boolean) | undefined;
  /** What a build-time render reads in place of the store's `init`, for a store that has none, such as a computed. */
  initial?: Value | undefined;
};

type SelectBuildValueParams<Value, Selected> = {
  store: Pick<StoreSource<Value>, 'init'>;
  select: (value: Value) => Selected;
  /** Wins over the store's `init` whenever it is defined, so a `null` or falsy value counts. */
  initial?: Value | undefined;
};

/**
 * Read a store as a Solid accessor that stops listening when its owner is disposed. Throws outside a component or
 * other reactive owner.
 *
 * Prefer `select` over reading one field of the whole value: Solid 2 runs an effect's function every time
 * its compute re-runs, even for an equal value. Pass `equals` (such as a shallow equality) when `select` builds
 * a new object or array.
 *
 * The accessor lags a synchronous `set` until Solid's next flush. Handlers acting on a value just written
 * read `store.get()`.
 *
 * A store with no `init`, such as a computed, is read with an `initial`.
 *
 * @example
 * const slice = useStore(store, state => ({ a: state.a, b: state.b }), { equals: isShallowEqual });
 * const total = useStore(totalStore, { initial: 0 });
 */
export function useStore<Value>(store: StoreSource<Value>, params?: UseStoreParams<Value, Value>): Accessor<Value>;
export function useStore<Value, Selected>(
  store: StoreSource<Value>,
  select: (value: Value) => Selected,
  params?: UseStoreParams<Value, Selected>,
): Accessor<Selected>;
export function useStore<Value, Selected>(
  store: StoreSource<Value>,
  selectOrParams?: ((value: Value) => Selected) | UseStoreParams<Value, Value | Selected>,
  selectParams: UseStoreParams<Value, Value | Selected> = {},
): Accessor<Value | Selected> {
  if (!getOwner()) {
    throw new Error('useStore must be called inside a component or reactive owner');
  }

  const select = typeof selectOrParams === 'function' ? selectOrParams : undefined;
  const { equals, initial } = typeof selectOrParams === 'object' ? selectOrParams : selectParams;

  const pick = (state: Value): Value | Selected => (select === undefined ? state : select(state));
  // The store notifies from whatever owner a producer's `set` runs under, so the write opts out of
  // Solid's owned-scope check.
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  onCleanup(store.listen(() => setVersion(version => version + 1)));
  // An island renders at build time from the initial value and may hydrate after boot wrote the store,
  // so `ssrSource: 'client'` keeps `loadingValue` until hydration completes.
  return createMemo(
    () => {
      version();
      return pick(store.get());
    },
    {
      ssrSource: 'client',
      loadingValue: selectBuildValue({ store, select: pick, initial }),
      ...(equals === undefined ? {} : { equals }),
    },
  );
}

/** The selected value a build-time render shows, from the reader's `initial` or else the store's `init`. */
export function selectBuildValue<Value, Selected>({
  store,
  select,
  initial,
}: SelectBuildValueParams<Value, Selected>): Selected {
  if (initial !== undefined) {
    return select(initial);
  }
  // A store with no `init`, such as a computed, is read with an `initial`, so here `init` holds the value.
  return select(store.init as Value);
}
