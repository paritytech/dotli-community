// Permission prompt. The Rust core awaits the typed response before encoding
// the product reply, so a slow modal blocks the product just as long as the
// user takes to dismiss it. Device grants also schedule an iframe reload so
// the browser sees the refreshed Permissions Policy `allow` attribute.
//
// "Always allow" and "Deny" are durable, matching the grant the topbar
// permissions menu shows and resets. "Allow once" is kept by the core for the
// current execution and consumed by the next operation that needs it, so it
// is offered only where the core is that gate: the submit permissions and
// Notifications. A grant gated by the iframe `allow` attribute reloads the
// product into a new execution, which would drop a one-time grant.
// Auto-grants answer `AllowOnce` so the core records nothing the user never
// saw. Each instance serves one product, so the product the core passes is
// already known as `label`.

import { withActiveTld } from "@dotli/config/network";
import type { PermissionDecision, Permissions } from "@parity/truapi-host";
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
import { createSubmitRateLimiter, type SubmitRateLimiter } from "./rate-limit";
import { ERRORS } from "../errors";

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
  limiter: SubmitRateLimiter = createSubmitRateLimiter(),
): Permissions {
  const devicePermission: Permissions["devicePermission"] = async (
    _product,
    tag,
  ) => {
    // OpenUrl has no host-side enforcement point; auto-grant rather than show
    // a modal whose deny button cannot block the underlying browser API.
    if (!isEnforceableDevicePermission(tag)) {
      return "AllowOnce";
    }
    return decidePromptPermission(
      label,
      tag,
      { kind: "Device", limiter },
      modalScope,
    );
  };

  const remotePermission: Permissions["remotePermission"] = async (
    _product,
    request,
  ) => {
    const name = gatedRemotePermissionName(request.permission.tag);
    if (name === null) {
      return "AllowOnce";
    }
    return decidePromptPermission(
      label,
      name,
      { kind: "Remote", limiter },
      modalScope,
    );
  };

  return { devicePermission, remotePermission };
}

interface PromptOptions {
  kind: "Device" | "Remote";
  limiter: { allow: () => boolean };
}

function decidePromptPermission(
  label: string,
  name: EnforceablePermissionName,
  options: PromptOptions,
  modalScope: BlockingModalScope,
): Promise<PermissionDecision> {
  return modalScope.enqueue((signal) =>
    decidePromptPermissionWhenActive(label, name, options, signal),
  );
}

async function decidePromptPermissionWhenActive(
  label: string,
  name: EnforceablePermissionName,
  options: PromptOptions,
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const { kind, limiter } = options;
  // Gated by the iframe `allow` attribute: a grant reloads the product.
  const gatedByIframe = isDevicePermission(name);
  const status = await getPermissionStatus(label, name);
  throwIfAborted(signal);
  if (status === "granted") {
    // The status also reflects a pending one-time grant, so answering
    // AllowAlways here would quietly make it permanent. AllowOnce leaves a
    // saved grant untouched.
    return "AllowOnce";
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
    return "Deny";
  }
  // status === "ask": show the modal and wait for the user.
  if (!limiter.allow()) {
    throw new Error(ERRORS.PERMISSION_PROMPT_RATE_LIMITED);
  }
  const decision = await showPermissionRequestModal(label, name, signal, {
    allowOnce: !gatedByIframe,
  });
  throwIfAborted(signal);
  if (decision === "dismissed") {
    throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
  }
  if (decision === "denied") {
    await setPermissionStatus(label, name, "denied");
    throwIfAborted(signal);
    return "Deny";
  }
  if (decision === "granted") {
    await setPermissionStatus(label, name, "granted");
    throwIfAborted(signal);
  }
  if (gatedByIframe) {
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
  } else {
    // No browser-level gate, so the grant takes effect as is. The event keeps
    // the topbar in sync.
    window.dispatchEvent(
      new CustomEvent("dotli:permission-changed", { detail: { label } }),
    );
  }
  return decision === "granted-once" ? "AllowOnce" : "AllowAlways";
}
