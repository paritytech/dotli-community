// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The status a layer publishes to the layer above. Reporting a listener's throw is injected, since this package cannot
// depend on metrics.

import { createListenerSet, type ListenerSetOptions } from './listener-set.js';

export type StatusCellOptions<T> = ListenerSetOptions<T>;

export interface StatusCell<T> {
  get: () => T;
  /** Does nothing when `next` is the status already. */
  set: (next: T) => void;
  /** Called on each change only, in order. A listener subscribed twice is two subscriptions. */
  subscribe: (listener: (value: T) => void) => () => void;
}

export function createStatusCell<T>(initial: T, options: StatusCellOptions<T>): StatusCell<T> {
  let value = initial;
  const listeners = createListenerSet<T>(options);
  return {
    get: () => value,
    set: next => {
      if (next === value) {
        return;
      }
      value = next;
      listeners.emit(next);
    },
    subscribe: listeners.subscribe,
  };
}
