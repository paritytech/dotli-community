import type { ProductStorage } from "@parity/truapi-host";
import { base64 } from "@scure/base";
import { UI_ERRORS } from "../errors";

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
        new Error(UI_ERRORS.STORAGE_READ_FAILED, { cause }),
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
      return Promise.reject(
        new Error(UI_ERRORS.STORAGE_WRITE_FAILED, { cause }),
      );
    }
  };
}

export function createLocalStorageClear(): ProductStorage["clear"] {
  return (key) => {
    try {
      localStorage.removeItem(storageKey(key));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(
        new Error(UI_ERRORS.STORAGE_CLEAR_FAILED, { cause }),
      );
    }
  };
}

function storageKey(key: string): string {
  return `dotli:${key}`;
}
