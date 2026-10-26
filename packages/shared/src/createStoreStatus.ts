// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StatusCell } from './createStatusCell.js';
import type { ReadableStore } from './createSyncStore.js';

/** A sync store read as a status, whose listener hears the store's value on each change. */
export function createStoreStatus<T>(
  store: Pick<ReadableStore<T>, 'get' | 'subscribe'>,
): Pick<StatusCell<T>, 'get' | 'subscribe'> {
  return {
    get: store.get,
    subscribe: listener =>
      store.subscribe(() => {
        listener(store.get());
      }),
  };
}
