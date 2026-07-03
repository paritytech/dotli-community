import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { base64 } from "@scure/base";

const SSO_DEVICE_IDENTITY_KEY = "truapi:sso-device-identity:v1";

export function createLocalStorageRead(): HostCallbacks["read"] {
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

export function createLocalStorageWrite(): HostCallbacks["write"] {
  return (key, value) => {
    try {
      localStorage.setItem(storageKey(key), base64.encode(value));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error("Failed to write to storage", { cause }));
    }
  };
}

export function createLocalStorageClear(): HostCallbacks["clear"] {
  return (key) => {
    try {
      if (key === SSO_DEVICE_IDENTITY_KEY) {
        clearSsoDeviceIdentities();
      }
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

function clearSsoDeviceIdentities(): void {
  const suffix = `:${SSO_DEVICE_IDENTITY_KEY}`;
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const itemKey = localStorage.key(index);
    if (itemKey?.startsWith("dotli:") === true && itemKey.endsWith(suffix)) {
      localStorage.removeItem(itemKey);
    }
  }
}
