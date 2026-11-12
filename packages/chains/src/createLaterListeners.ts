// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A listener told inside the call that set a change off could call back into its source before that source settled,
// so it hears the change once that call has returned.

type Params<T> = {
  /** Hears a listener's throw. Must not throw. */
  onListenerError: (error: unknown, value: T) => void;
};

/**
 * Listeners that hear each value in a microtask after its `emit`. Only a listener subscribed at the `emit`, and still
 * subscribed when the value arrives, hears it. Values arrive in the order they were emitted.
 */
export function createLaterListeners<T>({ onListenerError }: Params<T>) {
  const listeners = new Set<(value: T) => void>();

  return {
    /** A listener subscribed twice is two subscriptions. The returned unsubscribe may run more than once. */
    subscribe(listener: (value: T) => void): () => void {
      function callListener(value: T): void {
        listener(value);
      }
      listeners.add(callListener);
      return () => {
        listeners.delete(callListener);
      };
    },
    /** Every listener subscribed now hears `value` in a microtask, unless it unsubscribes first. Never throws. */
    emit(value: T): void {
      const hearing = [...listeners];
      queueMicrotask(() => {
        for (const listener of hearing.filter(subscribed => listeners.has(subscribed))) {
          deliver(listener, value);
        }
      });
    },
    /** One listener hears `value` at once, as a replay to a late subscriber does. Never throws. */
    deliver,
    get size(): number {
      return listeners.size;
    },
  };

  function deliver(listener: (value: T) => void, value: T): void {
    try {
      listener(value);
    } catch (error) {
      onListenerError(error, value);
    }
  }
}
