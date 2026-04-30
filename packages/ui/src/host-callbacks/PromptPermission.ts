// Permission prompt — collapses the legacy device/remote split into one
// synchronous `true|false` decision. The existing consent modal is async,
// so for `ask` state we return false synchronously (denying the request)
// and kick off the modal plus iframe reload in the background. Once the
// user grants, the reload re-runs the product with the permission set to
// `granted` so the next call resolves true without a round-trip.

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

function promptDevice(
  label: string,
  name: EnforceablePermissionName,
  limiter: { allow: () => boolean },
): void {
  if (!limiter.allow()) {
    return;
  }
  showPermissionRequestModal(label, name)
    .then(() => {
      setPermissionStatus(label, name, "granted");
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("dotli:device-permission-changed", {
            detail: { label, permission: name },
          }),
        );
      }, 0);
    })
    .catch(() => {
      setPermissionStatus(label, name, "denied");
    });
}

function promptRemote(
  label: string,
  name: EnforceablePermissionName,
  limiter: { allow: () => boolean },
): void {
  if (!limiter.allow()) {
    return;
  }
  showPermissionRequestModal(label, name)
    .then(() => {
      setPermissionStatus(label, name, "granted");
      window.dispatchEvent(
        new CustomEvent("dotli:permission-changed", {
          detail: { label },
        }),
      );
    })
    .catch(() => {
      setPermissionStatus(label, name, "denied");
    });
}

export function createPromptPermission(
  label: string,
): WasmHostCallbacks["promptPermission"] {
  const limiter = createSubmitRateLimiter();
  return (permission) => {
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

  function decide(
    label: string,
    name: EnforceablePermissionName,
    kind: "Device" | "Remote",
    limiter: { allow: () => boolean },
  ): boolean {
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
    if (kind === "Device") {
      promptDevice(label, name, limiter);
    } else {
      promptRemote(label, name, limiter);
    }
    return false;
  }
}
