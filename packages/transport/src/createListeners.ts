// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A provider's listeners, which hear nothing once it is disposed. */
export type Listeners = ReturnType<typeof createListeners>;

/** The listeners of one provider, which hear nothing once they are disposed. */
export function createListeners() {
  const listeners = new Set<(message: Uint8Array) => void>();
  let disposed = false;

  return {
    /** Hands `message` to each listener in turn. Once one disposes them, the rest hear nothing. */
    deliver,
    /** Adds `callback` until the returned function removes it. Adds nothing once disposed. */
    subscribe,
    /** Drops every listener. Returns false when already disposed. */
    dispose,
    /** Whether the listeners are disposed. */
    isDisposed,
  };

  function deliver(message: Uint8Array): void {
    for (const listener of [...listeners]) {
      // A listener may dispose the provider, after which the rest hear nothing.
      if (disposed) {
        return;
      }
      listener(message);
    }
  }

  function subscribe(callback: (message: Uint8Array) => void): () => void {
    if (disposed) {
      return () => undefined;
    }
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  function dispose(): boolean {
    if (disposed) {
      return false;
    }
    disposed = true;
    listeners.clear();
    return true;
  }

  function isDisposed(): boolean {
    return disposed;
  }
}
