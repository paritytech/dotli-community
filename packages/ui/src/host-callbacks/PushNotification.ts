// Push-notification callback. The Rust core passes the typed request, and
// this adapter returns a stable host-side id for cancel support.
//
// The core authorizes `Notifications` (prompting through `devicePermission`
// and consuming a one-time grant) before it calls here, so this adapter does
// not prompt or re-check: a second check would find a consumed "Allow once"
// gone and prompt the user again.

import type { Notifications } from "@parity/truapi-host";
import { log } from "@dotli/shared/log";
import {
  cancelNotification,
  scheduleNotification,
} from "../scheduled-notifications";
import { showNotification } from "../notification";
import { ERRORS } from "../errors";

export function createNotificationAdapters(
  label: string,
): Required<Notifications> {
  const pushNotification: Required<Notifications>["pushNotification"] = async ({
    text,
    deeplink,
    scheduledAt,
  }) => {
    log.warn(`[${label}] Push notification:`, {
      text,
      deeplink,
      scheduledAt,
    });

    const result = await scheduleNotification({
      productId: label,
      title: label,
      text,
      deeplink: deeplink ?? null,
      scheduledAt: scheduledAt === undefined ? null : Number(scheduledAt),
    });
    if (!result.ok) {
      throw new Error(ERRORS.SCHEDULE_LIMIT_REACHED);
    }

    if (result.immediate) {
      showNotification({ text, deeplink, label });
    }
    return { id: result.id };
  };

  const cancelPushNotification: Required<Notifications>["cancelNotification"] =
    async (id) => {
      await cancelNotification(label, id);
    };

  return { pushNotification, cancelNotification: cancelPushNotification };
}
