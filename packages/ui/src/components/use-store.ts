// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';
import type { ReadableStore } from '../state/create-store.js';

/**
 * Read a store as a Solid accessor that unsubscribes when its owner is disposed.
 *
 * Prefer `select` over reading one field of the whole value: Solid 2 runs an effect's function every time
 * its compute re-runs, even for an equal value. Pass `equals` (such as `shallowEqual`) when `select` builds
 * a new object or array.
 *
 * The accessor lags a synchronous `set` until Solid's next flush. Handlers acting on a value just written
 * read `store.get()`.
 */
export function useStore<T>(store: ReadableStore<T>): Accessor<T>;
export function useStore<T, S>(
  store: ReadableStore<T>,
  select: (value: T) => S,
  equals?: (prev: S, next: S) => boolean,
): Accessor<S>;
export function useStore<T, S>(
  store: ReadableStore<T>,
  select?: (value: T) => S,
  equals?: (prev: S, next: S) => boolean,
): Accessor<S> {
  if (!getOwner()) {
    throw new Error('useStore must be called inside a component or reactive owner');
  }

  const pick = (state: T): S => (select === undefined ? (state as unknown as S) : select(state));
  // The store notifies from whatever owner a producer's `set` runs under, so the write opts out of
  // Solid's owned-scope check.
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  onCleanup(store.subscribe(() => setVersion(n => n + 1)));
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
