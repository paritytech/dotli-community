// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Web storage that never throws. A browser that blocks storage (a private window, disabled cookies) throws on the
// access itself, and a full quota throws on a write. Every reader here treats that as nothing stored, and a refused
// write is lost for this page only, so the failure stops here.

export type SafeStorage = {
  /** The value stored under `key`, or null when there is none or storage is blocked. Never throws. */
  getItem: (key: string) => string | null;
  /** Stores `value` under `key`. A blocked storage or a full quota drops the write. Never throws. */
  setItem: (key: string, value: string) => void;
  /** Removes `key`. A key that is not stored, or a blocked storage, does nothing. Never throws. */
  removeItem: (key: string) => void;
  /** Removes every key. A blocked storage does nothing. Never throws. */
  clear: () => void;
};

/** Web storage that can also list its keys, for a reader that keeps some of them. */
export type ListableStorage = {
  /** Every stored key, none when storage is blocked. */
  keys: () => string[];
} & SafeStorage;

/** Reaches `open()` on every call, since reading `localStorage` itself throws where the browser blocks it. */
export function createSafeStorage(open: () => Storage): ListableStorage {
  return { getItem, setItem, removeItem, clear, keys };

  function getItem(key: string): string | null {
    return attempt(storage => storage.getItem(key), null);
  }

  function setItem(key: string, value: string): void {
    attempt(storage => {
      storage.setItem(key, value);
    }, undefined);
  }

  function removeItem(key: string): void {
    attempt(storage => {
      storage.removeItem(key);
    }, undefined);
  }

  function clear(): void {
    attempt(storage => {
      storage.clear();
    }, undefined);
  }

  function keys(): string[] {
    return attempt(storage => {
      const found: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key !== null) {
          found.push(key);
        }
      }
      return found;
    }, []);
  }

  function attempt<T>(use: (storage: Storage) => T, fallback: T): T {
    try {
      return use(open());
    } catch {
      return fallback;
    }
  }
}
