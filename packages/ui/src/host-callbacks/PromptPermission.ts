// Permission prompt. The Rust core awaits the typed response before encoding
// the product reply, so a slow modal blocks the product just as long as the
// user takes to dismiss it. Device grants also schedule an iframe reload so
// the browser sees the refreshed Permissions Policy `allow` attribute.

import { withActiveTld } from "@dotli/config/network";
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
import { createSubmitRateLimiter, type SubmitRateLimiter } from "./rate-limit";

const MAX_SESSION_REMOTE_DOMAINS = 32;
const MAX_CONCURRENT_REMOTE_PROMPTS = 4;

// Domain access is handled separately because decisions are scoped to this
// callback session and keyed by the normalized requested hosts.
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
  const remoteDomainDecisions = new Map<string, Promise<boolean>>();
  let pendingRemotePrompts = 0;
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
      const domains = normalizedRemoteDomains(request.permission.value.domains);
      if (domains === null) {
        return { granted: false };
      }
      const key = domains.join("\0");
      const existing = remoteDomainDecisions.get(key);
      if (existing !== undefined) {
        return { granted: await existing };
      }
      if (
        remoteDomainDecisions.size >= MAX_SESSION_REMOTE_DOMAINS ||
        pendingRemotePrompts >= MAX_CONCURRENT_REMOTE_PROMPTS
      ) {
        return { granted: false };
      }
      pendingRemotePrompts += 1;
      const decision = decideRemoteDomainPermission(
        label,
        domains,
        limiter,
        modalScope,
      ).finally(() => {
        pendingRemotePrompts -= 1;
      });
      remoteDomainDecisions.set(key, decision);
      void decision.catch(() => {
        if (remoteDomainDecisions.get(key) === decision) {
          remoteDomainDecisions.delete(key);
        }
      });
      return { granted: await decision };
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

function normalizedRemoteDomains(
  domains: readonly string[],
): readonly string[] | null {
  if (
    domains.length === 0 ||
    domains.length > 8 ||
    domains.some(
      (domain) =>
        domain.length > 253 ||
        !domain
          .split(".")
          .every((part) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part),
          ),
    )
  ) {
    return null;
  }
  return [...new Set(domains.map((domain) => domain.toLowerCase()))].sort();
}

async function decideRemoteDomainPermission(
  label: string,
  domains: readonly string[],
  limiter: SubmitRateLimiter,
  modalScope: BlockingModalScope,
): Promise<boolean> {
  return modalScope.enqueue(async (signal) => {
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
    return decision === "granted";
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
