// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';
import type { ReadableStore } from '../state/create-store.js';

/**
 * Read a store from a component. Returns a Solid accessor that follows the
 * store and unsubscribes when the owning component is disposed. Call it inside
 * a component or another reactive owner.
 *
 * With `select`, the accessor holds only that slice of the store's value, and
 * notifies its readers only when the slice changes (by `equals`, `===` by
 * default), so a write to another field re-runs none of them. Prefer a
 * selector over reading one field of the whole value: Solid 2 runs an
 * effect's function every time its compute re-runs, even for an equal value.
 * `select` runs once per store notification. Pass `equals` (for example
 * `shallowEqual`) when `select` builds a new object or array.
 *
 * The accessor lags a synchronous `set`: right after a producer writes, it
 * still returns the old value until Solid's next flush, while `store.get()` is
 * already current. In event handlers and effect functions that act on a value
 * just written, read `store.get()`.
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
  // Bumped on every store notification; the memo below reads it to follow
  // the store. The store notifies from whatever owner a producer's `set`
  // runs under, so the write opts out of Solid's owned-scope check.
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  onCleanup(store.subscribe(() => setVersion(n => n + 1)));
  // An island renders at build time from the store's initial value, and may
  // hydrate after boot has written the store: `ssrSource: 'client'` renders
  // `loadingValue` on the server and while hydrating, then computes the live
  // value once hydration completes. Outside hydration it computes at once.
  return createMemo(
    () => {
      version();
      return pick(store.get());
    },
    { ssrSource: 'client', loadingValue: pick(store.initial), ...(equals === undefined ? {} : { equals }) },
  );
}
