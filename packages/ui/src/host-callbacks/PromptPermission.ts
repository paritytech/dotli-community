// Permission prompt. The Rust core awaits the typed response before encoding
// the product reply, so a slow modal blocks the product just as long as the
// user takes to dismiss it. Device grants also schedule an iframe reload so
// the browser sees the refreshed Permissions Policy `allow` attribute.

import { withActiveTld } from "@dotli/config/network";
import type { Permissions } from "@parity/truapi-host";
import type { RemotePermission } from "@parity/truapi";
import {
  getPermissionStatus,
  getRemotePermissionStatus,
  isDevicePermission,
  isEnforceableDevicePermission,
  setPermissionStatus,
  setRemotePermissionStatus,
  type EnforceablePermissionName,
} from "../permissions";
import { showPermissionRequestModal } from "../permission-modal";
import { showNotification } from "../notification";
import {
  createBlockingModalScope,
  throwIfAborted,
  type BlockingModalScope,
} from "../blocking-modal-queue";
import { createSubmitRateLimiter, type SubmitRateLimiter } from "./rate-limit";

// Domain access is handled separately because its persisted key includes the
// requested hosts. WebRTC remains pre-resolved at iframe construction time.
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
  // One budget per host callback surface: `handlers.ts` passes the same
  // limiter here and to the notification adapters so a product cannot double
  // its prompt budget by alternating prompt kinds.
  limiter: SubmitRateLimiter = createSubmitRateLimiter(),
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
          limiter,
          reloadOnGrant: isDevicePermission(tag),
        },
        modalScope,
      ),
    };
  };

  const remotePermission: Permissions["remotePermission"] = async (request) => {
    if (request.permission.tag === "Remote") {
      return {
        granted: await decideRemoteDomainPermission(
          label,
          request.permission.value.domains,
          limiter,
          modalScope,
        ),
      };
    }
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
          limiter,
        },
        modalScope,
      ),
    };
  };

  return { devicePermission, remotePermission };
}

async function decideRemoteDomainPermission(
  label: string,
  domains: readonly string[],
  limiter: SubmitRateLimiter,
  modalScope: BlockingModalScope,
): Promise<boolean> {
  if (
    domains.length === 0 ||
    domains.length > 8 ||
    domains.some(
      (domain) =>
        domain.length > 253 ||
        !domain.split(".").every((part) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part),
        ),
    )
  ) {
    return false;
  }
  return modalScope.enqueue(async (signal) => {
    const status = await getRemotePermissionStatus(label, domains);
    throwIfAborted(signal);
    if (status === "granted") {
      return true;
    }
    if (status === "denied") {
      showNotification({
        label: withActiveTld(label),
        text: `Access to ${domains.join(", ")} is blocked by a remembered decision for this app.`,
        dismissMs: 6000,
        browserNotification: false,
      });
      return false;
    }
    if (!limiter.allow()) {
      throw new Error("Permission prompt rate limited");
    }
    const decision = await showPermissionRequestModal(
      label,
      { kind: "Remote", domains },
      signal,
    );
    throwIfAborted(signal);
    if (decision === "dismissed") {
      throw new Error("User dismissed permission dialog");
    }
    const granted = decision === "granted";
    await setRemotePermissionStatus(
      label,
      domains,
      granted ? "granted" : "denied",
    );
    throwIfAborted(signal);
    window.dispatchEvent(
      new CustomEvent("dotli:permission-changed", { detail: { label } }),
    );
    return granted;
  });
}

export async function decidePromptPermission(
  label: string,
  name: EnforceablePermissionName,
  options: {
    kind: "Device" | "Remote";
    limiter: { allow: () => boolean };
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
    limiter: { allow: () => boolean };
    reloadOnGrant?: boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const { kind, limiter, reloadOnGrant = false } = options;
  const status = await getPermissionStatus(label, name);
  throwIfAborted(signal);
  if (status === "granted") {
    return true;
  }
  if (status === "denied") {
    showNotification({
      label: withActiveTld(label),
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
    throw new Error("Permission prompt rate limited");
  }
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
