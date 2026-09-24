import type { ProductStorage } from "@parity/truapi-host";
import type { HostLocalStorageChangeItem } from "@parity/truapi";
import { bytesToHex } from "@parity/truapi/scale";
import { base64 } from "@scure/base";
import { ERRORS } from "../errors";
import { createResultStream } from "./result-stream";

// Same-window writes don't fire the `storage` event, so every runtime in this
// window (app frames and the chat worker) is told through this set instead.
// Other tabs are reached by the `storage` event.
type StorageListener = (key: string) => void;
const listeners = new Set<StorageListener>();

function notifyChanged(key: string): void {
  for (const listener of listeners) {
    listener(key);
  }
}

export function createLocalStorageRead(): ProductStorage["read"] {
  return (key) => {
    try {
      const raw = localStorage.getItem(storageKey(key));
      if (raw === null) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(base64.decode(raw));
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_READ_FAILED, { cause }));
    }
  };
}

export function createLocalStorageWrite(): ProductStorage["write"] {
  return (key, value) => {
    try {
      localStorage.setItem(storageKey(key), base64.encode(value));
      notifyChanged(key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_WRITE_FAILED, { cause }));
    }
  };
}

export function createLocalStorageClear(): ProductStorage["clear"] {
  return (key) => {
    try {
      localStorage.removeItem(storageKey(key));
      notifyChanged(key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_CLEAR_FAILED, { cause }));
    }
  };
}

// The core drops items repeating the last delivered value, so every write is
// forwarded without comparing bytes here.
export function createLocalStorageSubscribe(): ProductStorage["subscribeStorage"] {
  return (key) =>
    createResultStream<HostLocalStorageChangeItem>([], (push, pushError) => {
      const emit = (): void => {
        try {
          const raw = localStorage.getItem(storageKey(key));
          push(raw === null ? {} : { value: bytesToHex(base64.decode(raw)) });
        } catch {
          pushError({ reason: ERRORS.STORAGE_READ_FAILED });
        }
      };
      const onLocalChange: StorageListener = (changed) => {
        if (changed === key) {
          emit();
        }
      };
      const onStorage = (event: StorageEvent): void => {
        // `key === null` is a whole-storage `clear()` from another tab.
        if (event.key === null || event.key === storageKey(key)) {
          emit();
        }
      };
      listeners.add(onLocalChange);
      window.addEventListener("storage", onStorage);
      emit();
      return () => {
        listeners.delete(onLocalChange);
        window.removeEventListener("storage", onStorage);
      };
    });
}

function storageKey(key: string): string {
  return `dotli:${key}`;
}
