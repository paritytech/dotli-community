// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The status a layer publishes to the layer above. Reporting a listener's throw is injected, since this package cannot
// depend on metrics.

export interface StatusCellOptions<T> {
  /** Hears a listener that threw. The other listeners still hear the change. */
  onListenerError: (error: unknown, value: T) => void;
}

export interface StatusCell<T> {
  get: () => T;
  /** Does nothing when `next` is the status already. */
  set: (next: T) => void;
  /** Called on each change only, in order. A listener subscribed twice is two subscriptions. */
  subscribe: (listener: (value: T) => void) => () => void;
}

export function createStatusCell<T>(initial: T, options: StatusCellOptions<T>): StatusCell<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  let delivering = false;
  const undelivered: { value: T; listeners: ((value: T) => void)[] }[] = [];

  return {
    get: () => value,
    set: next => {
      if (next === value) {
        return;
      }
      value = next;
      // A change a listener causes waits for the round in progress, so every listener hears the changes in order, and
      // only those subscribed when the change happened.
      undelivered.push({ value: next, listeners: [...listeners] });
      if (delivering) {
        return;
      }
      delivering = true;
      try {
        for (let step = undelivered.shift(); step !== undefined; step = undelivered.shift()) {
          // Not those unsubscribed since the change. Fixed as the round starts, so a listener removed by another
          // still hears this change, and nothing after it.
          for (const listener of step.listeners.filter(subscribed => listeners.has(subscribed))) {
            try {
              listener(step.value);
            } catch (error) {
              options.onListenerError(error, step.value);
            }
          }
        }
      } finally {
        delivering = false;
        // Empty unless the error handler threw out of the round, and a later round must not deliver what it left.
        undelivered.length = 0;
      }
    },
    subscribe: listener => {
      const wrapped = (next: T): void => {
        listener(next);
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
  };
}
