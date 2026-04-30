// Permission prompt — collapses the legacy device/remote split into one
// async `true|false` decision. Returns a Promise<boolean>; the Rust core
// awaits it before encoding the response, so a slow modal blocks the
// product just as long as the user takes to dismiss it. If the iframe
// reloads while the promise is pending (device-permission grant path),
// the worker disappears and the response is dropped — the product on the
// new iframe retries and reads the cached decision instead.

import type {
  HostPermission,
  WasmHostCallbacks,
} from "@truapi/host-shared";
import type { RemotePermission } from "@truapi/client";
import {
  getPermissionStatus,
  isEnforceableDevicePermission,
  setPermissionStatus,
  type DevicePermissionName,
  type EnforceablePermissionName,
} from "../permissions";
import { showPermissionRequestModal } from "../permission-modal";
import { showNotification } from "../notification";
import { createSubmitRateLimiter } from "./rate-limit";

// Storage uses uppercase `NFC`; the TrUAPI codec emits Pascal-cased `Nfc`.
// Other device tags align one-to-one.
function toDevicePermissionName(
  tag: (HostPermission & { tag: "Device" })["value"]["tag"],
): DevicePermissionName {
  return tag === "Nfc" ? "NFC" : (tag as DevicePermissionName);
}

// Remote tags that don't reach a host enforcement point: WebRtc is gated
// by the iframe `allow` attribute, and `Remote` (HTTP/WS) can't be
// reliably intercepted from inside the sandbox. Auto-grant either.
function gatedRemotePermissionName(
  tag: RemotePermission["tag"],
): EnforceablePermissionName | null {
  switch (tag) {
    case "ChainSubmit":
    case "StatementSubmit":
      return tag;
    case "Remote":
    case "WebRtc":
      return null;
  }
}

export function createPromptPermission(
  label: string,
): WasmHostCallbacks["promptPermission"] {
  const limiter = createSubmitRateLimiter();
  return async (permission) => {
    if (permission.tag === "Device") {
      const tag = toDevicePermissionName(permission.value.tag);
      // Notifications / OpenUrl have no host-side enforcement point;
      // auto-grant rather than show a modal whose deny button can't
      // actually block the underlying browser API.
      if (!isEnforceableDevicePermission(tag)) {
        return true;
      }
      return decide(label, tag, "Device", limiter);
    }

    const name = gatedRemotePermissionName(permission.value.tag);
    if (name === null) {
      return true;
    }
    return decide(label, name, "Remote", limiter);
  };
}

async function decide(
  label: string,
  name: EnforceablePermissionName,
  kind: "Device" | "Remote",
  limiter: { allow: () => boolean },
): Promise<boolean> {
  const status = getPermissionStatus(label, name);
  if (status === "granted") {
    return true;
  }
  if (status === "denied") {
    showNotification({
      label: `${label}.dot`,
      text:
        kind === "Device"
          ? `${name} access is blocked. Use the permissions menu in the top bar to change this.`
          : "Transaction signing is blocked. Use the permissions menu in the top bar to change this.",
      dismissMs: 6000,
      browserNotification: false,
    });
    return false;
  }
  // status === "ask": show the modal and wait for the user.
  if (!limiter.allow()) {
    return false;
  }
  try {
    await showPermissionRequestModal(label, name);
  } catch {
    setPermissionStatus(label, name, "denied");
    return false;
  }
  setPermissionStatus(label, name, "granted");
  if (kind === "Device") {
    // Device permissions are also gated by the iframe `allow` attribute,
    // which is fixed at iframe load time. Reload so the next attempt sees
    // the updated attribute. Defer to the next tick so the prompt response
    // can flush before the iframe is disposed; return `false` because the
    // current call dies with the iframe and the product will retry on the
    // fresh one (which will short-circuit on the now-cached "granted").
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("dotli:device-permission-changed", {
          detail: { label, permission: name },
        }),
      );
    }, 0);
    return false;
  }
  // Remote permissions have no browser-level gate, so we can return the
  // actual grant. The event keeps the topbar in sync.
  window.dispatchEvent(
    new CustomEvent("dotli:permission-changed", { detail: { label } }),
  );
  return true;
}
