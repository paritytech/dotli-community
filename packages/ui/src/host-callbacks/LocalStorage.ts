import type { HostCallbacks } from "@parity/truapi-host/callbacks";
import { base64 } from "@scure/base";

const SSO_DEVICE_IDENTITY_KEY = "truapi:sso-device-identity:v1";

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
      if (key === SSO_DEVICE_IDENTITY_KEY) {
        clearSsoDeviceIdentities();
      }
      localStorage.removeItem(storagePrefix + key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error("Failed to clear storage", { cause }));
    }
  };
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
