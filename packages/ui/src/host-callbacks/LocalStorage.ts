import type { ProductStorage } from "@parity/truapi-host";
import { base64 } from "@scure/base";

export function createLocalStorageRead(): ProductStorage["read"] {
  return (key) => {
    try {
      const raw = localStorage.getItem(storageKey(key));
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

export function createLocalStorageWrite(): ProductStorage["write"] {
  return (key, value) => {
    try {
      localStorage.setItem(storageKey(key), base64.encode(value));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error("Failed to write to storage", { cause }));
    }
  };
}

export function createLocalStorageClear(): ProductStorage["clear"] {
  return (key) => {
    try {
      localStorage.removeItem(storageKey(key));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error("Failed to clear storage", { cause }));
    }
  };
}

function storageKey(key: string): string {
  return `dotli:${key}`;
}
