// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';
import type { ReadableStore } from '@dotli/shared';

type Params<Selected> = {
  /** Whether two selected values count as the same, so the accessor keeps the first. */
  equals?: ((previous: Selected, next: Selected) => boolean) | undefined;
};

/**
 * Read a store as a Solid accessor that unsubscribes when its owner is disposed. Throws outside a component or other
 * reactive owner.
 *
 * Prefer `select` over reading one field of the whole value: Solid 2 runs an effect's function every time
 * its compute re-runs, even for an equal value. Pass `equals` (such as `isShallowEqual`) when `select` builds
 * a new object or array.
 *
 * The accessor lags a synchronous `set` until Solid's next flush. Handlers acting on a value just written
 * read `store.get()`.
 *
 * @example
 * const slice = useStore(store, state => ({ a: state.a, b: state.b }), { equals: isShallowEqual });
 */
export function useStore<Value>(store: ReadableStore<Value>): Accessor<Value>;
export function useStore<Value, Selected>(
  store: ReadableStore<Value>,
  select: (value: Value) => Selected,
  params?: Params<Selected>,
): Accessor<Selected>;
export function useStore<Value, Selected>(
  store: ReadableStore<Value>,
  select?: (value: Value) => Selected,
  { equals }: Params<Value | Selected> = {},
): Accessor<Value | Selected> {
  if (!getOwner()) {
    throw new Error('useStore must be called inside a component or reactive owner');
  }

  const pick = (state: Value): Value | Selected => (select === undefined ? state : select(state));
  // The store notifies from whatever owner a producer's `set` runs under, so the write opts out of
  // Solid's owned-scope check.
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  onCleanup(store.subscribe(() => setVersion(version => version + 1)));
  // An island renders at build time from the initial value and may hydrate after boot wrote the store,
  // so `ssrSource: 'client'` keeps `loadingValue` until hydration completes.
  return createMemo(
    () => {
      version();
      return pick(store.get());
    },
    { ssrSource: 'client', loadingValue: pick(store.initial), ...(equals === undefined ? {} : { equals }) },
  );
}
