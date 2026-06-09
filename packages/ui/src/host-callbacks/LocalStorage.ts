import type { HostCallbacks } from "@parity/truapi-host-wasm";

const BINARY_STRING_CHUNK_SIZE = 0x8000;

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += BINARY_STRING_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...value.subarray(offset, offset + BINARY_STRING_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

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
      localStorage.setItem(storagePrefix + key, bytesToBase64(value));
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
