// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Delivers a value to every listener, so one that throws cannot keep it from the others. Reporting the throw is
// injected, since this package cannot depend on metrics: each owner passes its report.

export interface ListenerSetOptions<T> {
  /** Hears a listener that threw. The other listeners still hear the value. */
  onListenerError: (error: unknown, value: T) => void;
}

export interface ListenerSet<T> {
  /** A listener subscribed twice is two subscriptions. The returned unsubscribe may run more than once. */
  subscribe: (listener: (value: T) => void) => () => void;
  /**
   * Every listener subscribed now hears `value`, in order. A value emitted while listeners hear another waits for that
   * round, so every listener hears the values in order, and only those subscribed when the value was emitted.
   */
  emit: (value: T) => void;
  /** One listener hears `value` at once, under the same report, as a replay to a late subscriber does. */
  deliver: (listener: (value: T) => void, value: T) => void;
  readonly size: number;
}

export function createListenerSet<T>(options: ListenerSetOptions<T>): ListenerSet<T> {
  const listeners = new Set<(value: T) => void>();
  let delivering = false;
  const undelivered: { value: T; listeners: ((value: T) => void)[] }[] = [];

  const deliver = (listener: (value: T) => void, value: T): void => {
    try {
      listener(value);
    } catch (error) {
      options.onListenerError(error, value);
    }
  };

  return {
    subscribe: listener => {
      const wrapped = (value: T): void => {
        listener(value);
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
    emit: value => {
      undelivered.push({ value, listeners: [...listeners] });
      if (delivering) {
        return;
      }
      delivering = true;
      try {
        for (let step = undelivered.shift(); step !== undefined; step = undelivered.shift()) {
          // Not those unsubscribed since the value was emitted. Fixed as the round starts, so a listener removed by
          // another still hears this value, and nothing after it.
          for (const listener of step.listeners.filter(subscribed => listeners.has(subscribed))) {
            deliver(listener, step.value);
          }
        }
      } finally {
        delivering = false;
        // Empty unless the error handler threw out of the round, and a later round must not deliver what it left.
        undelivered.length = 0;
      }
    },
    deliver,
    get size() {
      return listeners.size;
    },
  };
}
