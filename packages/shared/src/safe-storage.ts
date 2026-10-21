// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Web storage that never throws. A browser that blocks storage (a private window, disabled cookies) throws on the
// access itself, and a full quota throws on a write. Every reader here treats that as nothing stored, and a refused
// write is lost for this page only, so the failure stops here.

export interface SafeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

/** Reaches `open()` on every call, since reading `localStorage` itself throws where the browser blocks it. */
export function safeStorage(open: () => Storage): SafeStorage {
  const attempt = <T>(use: (storage: Storage) => T, fallback: T): T => {
    try {
      return use(open());
    } catch {
      return fallback;
    }
  };
  return {
    getItem: key => attempt(storage => storage.getItem(key), null),
    setItem: (key, value) => {
      attempt(storage => {
        storage.setItem(key, value);
      }, undefined);
    },
    removeItem: key => {
      attempt(storage => {
        storage.removeItem(key);
      }, undefined);
    },
    clear: () => {
      attempt(storage => {
        storage.clear();
      }, undefined);
    },
  };
}

/** This origin's localStorage. */
export const pageLocalStorage: SafeStorage = safeStorage(() => localStorage);

/** This tab's sessionStorage. */
export const pageSessionStorage: SafeStorage = safeStorage(() => sessionStorage);
