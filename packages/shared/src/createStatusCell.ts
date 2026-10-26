// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The status a layer publishes to the layer above. Reporting a listener's throw is injected, since this package cannot
// depend on metrics.

import { createListenerSet, type ListenerSetParams } from './createListenerSet.js';

type Params<T> = ListenerSetParams<T> & {
  initial: T;
};

export type StatusCell<T> = ReturnType<typeof createStatusCell<T>>;

/** A status a layer sets and the layer above reads and hears. */
export function createStatusCell<T>({ initial, ...listenerSetParams }: Params<T>) {
  let value = initial;
  const listeners = createListenerSet<T>(listenerSetParams);

  return {
    get,
    /** Does nothing when `next` is the status already. */
    set,
    /** Called on each change only, in order. A listener subscribed twice is two subscriptions. */
    subscribe: listeners.subscribe,
  };

  function get(): T {
    return value;
  }

  function set(next: T): void {
    if (next === value) {
      return;
    }
    value = next;
    listeners.emit(next);
  }
}
