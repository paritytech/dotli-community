// Permission prompt. The Rust core awaits the typed response before encoding
// the product reply, so a slow modal blocks the product just as long as the
// user takes to dismiss it. Device grants also schedule an iframe reload so
// the browser sees the refreshed Permissions Policy `allow` attribute.

import type { Permissions } from "@parity/truapi-host";
import type { RemotePermission } from "@parity/truapi";
import {
  getPermissionStatus,
  isDevicePermission,
  isEnforceableDevicePermission,
  setPermissionStatus,
  type EnforceablePermissionName,
} from "../permissions";
import { showPermissionRequestModal } from "../permission-modal";
import { showNotification } from "../notification";
import {
  createBlockingModalScope,
  throwIfAborted,
  type BlockingModalScope,
} from "../blocking-modal-queue";

// Remote tags that don't reach a host enforcement point: WebRtc is gated
// by the iframe `allow` attribute, and `Remote` (HTTP/WS) can't be
// reliably intercepted from inside the sandbox. Auto-grant either.
function gatedRemotePermissionName(
  tag: RemotePermission["tag"],
): EnforceablePermissionName | null {
  switch (tag) {
    case "ChainSubmit":
    case "PreimageSubmit":
    case "StatementSubmit":
      return tag;
    case "Remote":
    case "WebRtc":
      return null;
  }
}

export function createPromptPermission(
  label: string,
  modalScope: BlockingModalScope = createBlockingModalScope(),
): Permissions {
  const devicePermission: Permissions["devicePermission"] = async (tag) => {
    // OpenUrl has no host-side enforcement point; auto-grant rather than show
    // a modal whose deny button cannot block the underlying browser API.
    if (!isEnforceableDevicePermission(tag)) {
      return { granted: true };
    }
    return {
      granted: await decidePromptPermission(
        label,
        tag,
        {
          kind: "Device",
          reloadOnGrant: isDevicePermission(tag),
        },
        modalScope,
      ),
    };
  };

  const remotePermission: Permissions["remotePermission"] = async (request) => {
    const name = gatedRemotePermissionName(request.permission.tag);
    if (name === null) {
      return { granted: true };
    }
    return {
      granted: await decidePromptPermission(
        label,
        name,
        {
          kind: "Remote",
        },
        modalScope,
      ),
    };
  };

  return { devicePermission, remotePermission };
}

export async function decidePromptPermission(
  label: string,
  name: EnforceablePermissionName,
  options: {
    kind: "Device" | "Remote";
    reloadOnGrant?: boolean;
  },
  modalScope: BlockingModalScope = createBlockingModalScope(),
): Promise<boolean> {
  return modalScope.enqueue((signal) =>
    decidePromptPermissionWhenActive(label, name, options, signal),
  );
}

async function decidePromptPermissionWhenActive(
  label: string,
  name: EnforceablePermissionName,
  options: {
    kind: "Device" | "Remote";
    reloadOnGrant?: boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const { kind, reloadOnGrant = false } = options;
  const status = await getPermissionStatus(label, name);
  throwIfAborted(signal);
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
  const decision = await showPermissionRequestModal(label, name, signal);
  throwIfAborted(signal);
  if (decision === "dismissed") {
    throw new Error("User dismissed permission dialog");
  }
  if (decision === "denied") {
    throwIfAborted(signal);
    await setPermissionStatus(label, name, "denied");
    throwIfAborted(signal);
    return false;
  }
  throwIfAborted(signal);
  await setPermissionStatus(label, name, "granted");
  throwIfAborted(signal);
  if (kind === "Device" && reloadOnGrant) {
    // Device permissions are also gated by the iframe `allow` attribute,
    // which is fixed at iframe load time. Reload so the next attempt sees
    // the updated attribute. Defer to the next tick so the prompt response
    // can flush before the iframe is disposed.
    setTimeout(() => {
      if (signal.aborted) {
        return;
      }
      window.dispatchEvent(
        new CustomEvent("dotli:device-permission-changed", {
          detail: { label, permission: name },
        }),
      );
    }, 0);
    return true;
  }
  // Remote permissions have no browser-level gate, so we can return the
  // actual grant. The event keeps the topbar in sync.
  throwIfAborted(signal);
  window.dispatchEvent(
    new CustomEvent("dotli:permission-changed", { detail: { label } }),
  );
  return true;
}
