// Push-notification callback. The Rust core passes the typed request, and
// this adapter returns a stable host-side id for cancel support.

import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { log } from "@dotli/shared/log";
import {
  cancelNotification,
  scheduleNotification,
} from "../scheduled-notifications";
import { showNotification } from "../notification";
import { getPermissionStatus, setPermissionStatus } from "../permissions";
import { showPermissionRequestModal } from "../permission-modal";

export function createNotificationAdapters(
  label: string,
): Pick<HostCallbacks, "pushNotification" | "cancelNotification"> {
  const pushNotification: HostCallbacks["pushNotification"] = async ({
    text,
    deeplink,
    scheduledAt,
  }) => {
    log.warn(`[${label}] Push notification:`, {
      text,
      deeplink,
      scheduledAt,
    });

    const granted = await requestNotificationPermission(label);
    if (!granted) {
      throw new Error("Notifications permission denied");
    }

    const result = await scheduleNotification({
      productId: label,
      title: label,
      text,
      deeplink: deeplink ?? null,
      scheduledAt: scheduledAt === undefined ? null : Number(scheduledAt),
    });
    if (!result.ok) {
      throw new Error("ScheduleLimitReached");
    }

    if (result.immediate) {
      showNotification({ text, deeplink, label });
    }
    return { id: result.id };
  };

  const cancelPushNotification: HostCallbacks["cancelNotification"] = async (
    id,
  ) => {
    await cancelNotification(label, id);
  };

  return { pushNotification, cancelNotification: cancelPushNotification };
}

async function requestNotificationPermission(label: string): Promise<boolean> {
  const status = getPermissionStatus(label, "Notifications");
  if (status === "granted") {
    return true;
  }
  if (status === "denied") {
    return false;
  }
  try {
    await showPermissionRequestModal(label, "Notifications");
    setPermissionStatus(label, "Notifications", "granted");
    window.dispatchEvent(
      new CustomEvent("dotli:permission-changed", { detail: { label } }),
    );
    return true;
  } catch {
    setPermissionStatus(label, "Notifications", "denied");
    window.dispatchEvent(
      new CustomEvent("dotli:permission-changed", { detail: { label } }),
    );
    return false;
  }
}
