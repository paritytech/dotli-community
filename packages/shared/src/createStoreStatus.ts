// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StatusCell } from './createStatusCell.js';
import type { ReadableStore } from './createSyncStore.js';

/**
 * A sync store read as a status, whose listener hears the store's value on each change.
 *
 * @example
 * const status = createStoreStatus(store); // hand `status` up, and keep `store.set` to the owner
 * status.subscribe(value => render(value));
 */
export function createStoreStatus<T>(
  store: Pick<ReadableStore<T>, 'get' | 'subscribe' | 'listen'>,
): Pick<StatusCell<T>, 'get' | 'subscribe' | 'listen'> {
  return {
    get: store.get,
    listen: store.listen,
    subscribe: listener =>
      store.subscribe(() => {
        listener(store.get());
      }),
  };
}
