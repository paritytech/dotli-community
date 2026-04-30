// Mirrors the legacy `container.handleLocalStorage*` bodies: base64
// round-trip into `window.localStorage[storagePrefix + key]`. Throwing an
// Error is the documented contract on `WasmHostCallbacks` failure.

import type { WasmHostCallbacks } from "@truapi/host-shared";

export function createLocalStorageRead(
  storagePrefix: string,
): WasmHostCallbacks["localStorageRead"] {
  return (key) => {
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
): WasmHostCallbacks["localStorageWrite"] {
  return (key, value) => {
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
): WasmHostCallbacks["localStorageClear"] {
  return (key) => {
    try {
      localStorage.removeItem(storagePrefix + key);
    } catch {
      throw new Error("Failed to clear storage");
    }
  };
}
