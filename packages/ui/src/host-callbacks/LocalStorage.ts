// Mirrors the legacy `container.handleLocalStorage*` bodies: base64
// round-trip into `window.localStorage[storagePrefix + key]`.

import type { HostCallbacks } from "@parity/truapi-host-wasm";

export function createLocalStorageRead(
  storagePrefix: string,
): HostCallbacks["read"] {
  return async (key) => {
    try {
      const raw = localStorage.getItem(storagePrefix + key);
      if (raw === null) {
        return undefined;
      }
      return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    } catch {
      throw new Error("Failed to read from storage");
    }
  };
}

export function createLocalStorageWrite(
  storagePrefix: string,
): HostCallbacks["write"] {
  return async (key, value) => {
    try {
      const b64 = btoa(String.fromCharCode(...value));
      localStorage.setItem(storagePrefix + key, b64);
    } catch {
      throw new Error("Failed to write to storage");
    }
  };
}

export function createLocalStorageClear(
  storagePrefix: string,
): HostCallbacks["clear"] {
  return async (key) => {
    try {
      localStorage.removeItem(storagePrefix + key);
    } catch {
      throw new Error("Failed to clear storage");
    }
  };
}
