import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { base64 } from "@scure/base";

export function createLocalStorageRead(
  storagePrefix: string,
): HostCallbacks["read"] {
  return (key) => {
    try {
      const raw = localStorage.getItem(storagePrefix + key);
      if (raw === null) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(base64.decode(raw));
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
      localStorage.setItem(storagePrefix + key, base64.encode(value));
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
