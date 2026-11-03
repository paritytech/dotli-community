// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The status a layer publishes to the layer above. Reporting a listener's throw is injected, since this package cannot
// depend on metrics.

import { createListenerSet, type ListenerSetParams } from './createListenerSet.js';

type Params<T> = ListenerSetParams<T> & {
  initial: T;
};

type Change<T> = { value: T; oldValue: T };

export type StatusCell<T> = ReturnType<typeof createStatusCell<T>>;

/**
 * A status a layer sets and the layer above reads and hears.
 *
 * @example
 * const status = createStatusCell<'idle' | 'ready'>({ initial: 'idle', onListenerError: report });
 * status.set('ready');
 */
export function createStatusCell<T>({ initial, onListenerError }: Params<T>) {
  let value = initial;
  const listeners = createListenerSet<Change<T>>({
    onListenerError: (error, change) => {
      onListenerError(error, change.value);
    },
  });

  return {
    get,
    /** Does nothing when `next` is the status already. */
    set,
    /** Hears each change only, in order, with the status it replaced. A listener given twice is two subscriptions. */
    listen,
  };

  function get(): T {
    return value;
  }

  function set(next: T): void {
    if (next === value) {
      return;
    }
    const oldValue = value;
    value = next;
    listeners.emit({ value: next, oldValue });
  }

  function listen(listener: (value: T, oldValue: T | undefined) => void): () => void {
    return listeners.subscribe(change => {
      listener(change.value, change.oldValue);
    });
  }
}
