// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// happy-dom exposes `navigator.locks` as null. Host code fails closed without
// Web Locks, so tests that boot a page core install this exclusive, in-memory
// LockManager (one document, no shared mode).

interface Held {
  name: string;
  mode: LockMode;
}

type LockCallback<T> = (lock: Lock | null) => T | PromiseLike<T>;

export function installWebLocks(): () => void {
  const tails = new Map<string, Promise<void>>();
  const held = new Map<string, number>();
  const locks = {
    request<T>(name: string, options: LockOptions | LockCallback<T>, callback?: LockCallback<T>): Promise<T> {
      const run = typeof options === 'function' ? options : callback;
      const ifAvailable = typeof options === 'object' && options.ifAvailable === true;
      if (run === undefined) {
        return Promise.reject(new TypeError('Lock callback is required'));
      }
      if (ifAvailable && (held.get(name) ?? 0) > 0) {
        return Promise.resolve().then(() => run(null));
      }
      const result = (tails.get(name) ?? Promise.resolve()).then(async () => {
        held.set(name, (held.get(name) ?? 0) + 1);
        try {
          return await run({ name, mode: 'exclusive' });
        } finally {
          held.set(name, (held.get(name) ?? 1) - 1);
        }
      });
      tails.set(
        name,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },
    query(): Promise<LockManagerSnapshot> {
      const current: Held[] = [...held].filter(([, count]) => count > 0).map(([name]) => ({ name, mode: 'exclusive' }));
      return Promise.resolve({ held: current, pending: [] });
    },
  };
  const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(navigator, 'locks');
    } else {
      Object.defineProperty(navigator, 'locks', previous);
    }
  };
}

/** A browser Media backend double: advertises nothing and records no media. */
export function fakeBrowserMediaBackend(): Record<string, (...args: unknown[]) => unknown> {
  return {
    attach: () => undefined,
    detach: () => undefined,
    refreshViewport: () => undefined,
    revokePermission: () => undefined,
    dispose: () => undefined,
    mediaBackendCapabilities: () => Promise.resolve({ tag: 'Unsupported' }),
    mediaBackendEvents: () => () => undefined,
    mediaBackendCommand: () => Promise.reject(new Error('Media:Unsupported')),
  };
}
