import type { ProductStorage } from "@parity/truapi-host";
import { base64 } from "@scure/base";
import { bytesToHex } from "@parity/truapi/scale";
import type { HostLocalStorageChangeItem } from "@parity/truapi";
import { createResultStream } from "./result-stream";

const STORAGE_CHANGED = "dotli:product-storage-changed";

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
      window.dispatchEvent(new CustomEvent(STORAGE_CHANGED, { detail: key }));
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
      window.dispatchEvent(new CustomEvent(STORAGE_CHANGED, { detail: key }));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error("Failed to clear storage", { cause }));
    }
  };
}

export function createLocalStorageSubscribe(): ProductStorage["subscribeStorage"] {
  return (key) =>
    createResultStream<HostLocalStorageChangeItem>([], (push, pushError) => {
      const publish = (): void => {
        try {
          const raw = localStorage.getItem(storageKey(key));
          push({
            value: raw === null ? undefined : bytesToHex(base64.decode(raw)),
          });
        } catch (cause) {
          pushError({ reason: String(cause) });
        }
      };
      const localChanged = (event: Event): void => {
        if ((event as CustomEvent<string>).detail === key) {
          publish();
        }
      };
      const remoteChanged = (event: StorageEvent): void => {
        if (
          event.storageArea === localStorage &&
          (event.key === null || event.key === storageKey(key))
        ) {
          publish();
        }
      };
      window.addEventListener(STORAGE_CHANGED, localChanged);
      window.addEventListener("storage", remoteChanged);
      publish();
      return () => {
        window.removeEventListener(STORAGE_CHANGED, localChanged);
        window.removeEventListener("storage", remoteChanged);
      };
    });
}

function storageKey(key: string): string {
  return `dotli:${key}`;
}
