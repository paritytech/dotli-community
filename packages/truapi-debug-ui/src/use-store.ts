// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';
import type { ReadableStore } from '@dotli/shared';

/**
 * Read a store as a Solid accessor that unsubscribes when its owner is disposed.
 *
 * The accessor lags a synchronous `set` until Solid's next flush. Handlers acting on a value just written
 * read `store.get()`.
 */
export function useStore<T>(store: ReadableStore<T>): Accessor<T> {
  if (!getOwner()) {
    throw new Error('useStore must be called inside a component or reactive owner');
  }

  // The store notifies from whatever owner a producer's `set` runs under, so the write opts out of
  // Solid's owned-scope check.
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  onCleanup(store.subscribe(() => setVersion(n => n + 1)));
  return createMemo(() => {
    version();
    return store.get();
  });
}
