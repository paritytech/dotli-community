// Mirrors the legacy `container.handleLocalStorage*` bodies: base64
// round-trip into `window.localStorage[storagePrefix + key]`.

import type { HostCallbacks } from "@parity/truapi-host-wasm";

export function createLocalStorageRead(
  storagePrefix: string,
): HostCallbacks["read"] {
  return (key) => {
    try {
      const raw = localStorage.getItem(storagePrefix + key);
      if (raw === null) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(
        Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
      );
    } catch (cause) {
      return Promise.reject(
        new Error("Failed to read from storage", { cause }),
      );
    }
  };
}

export function createLocalStorageWrite(
  storagePrefix: string,
): HostCallbacks["write"] {
  return (key, value) => {
    try {
      const b64 = btoa(String.fromCharCode(...value));
      localStorage.setItem(storagePrefix + key, b64);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error("Failed to write to storage", { cause }));
    }
  };
}

export function createLocalStorageClear(
  storagePrefix: string,
): HostCallbacks["clear"] {
  return (key) => {
    try {
      localStorage.removeItem(storagePrefix + key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error("Failed to clear storage", { cause }));
    }
  };
}
