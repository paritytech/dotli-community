// Push-notification callback. The Rust core passes the typed request, and
// this adapter returns a stable host-side id for cancel support.

import type { Notifications } from "@parity/truapi-host";
import { log } from "@dotli/shared/log";
import {
  cancelNotification,
  scheduleNotification,
} from "../scheduled-notifications";
import { showNotification } from "../notification";
import { decidePromptPermission } from "./PromptPermission";
import {
  createBlockingModalScope,
  type BlockingModalScope,
} from "../blocking-modal-queue";
import { createSubmitRateLimiter, type SubmitRateLimiter } from "./rate-limit";
import { UI_ERRORS } from "../errors";

export function createNotificationAdapters(
  label: string,
  modalScope: BlockingModalScope = createBlockingModalScope(),
  // One budget per host callback surface: `handlers.ts` passes the same
  // limiter here and to the permission prompts so a product cannot double
  // its prompt budget by alternating prompt kinds.
  limiter: SubmitRateLimiter = createSubmitRateLimiter(),
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

    const granted = await decidePromptPermission(
      label,
      "Notifications",
      {
        kind: "Device",
        limiter,
      },
      modalScope,
    );
    if (!granted) {
      throw new Error(UI_ERRORS.NOTIFICATIONS_PERMISSION_DENIED);
    }

    const result = await scheduleNotification({
      productId: label,
      title: label,
      text,
      deeplink: deeplink ?? null,
      scheduledAt: scheduledAt === undefined ? null : Number(scheduledAt),
    });
    if (!result.ok) {
      throw new Error(UI_ERRORS.SCHEDULE_LIMIT_REACHED);
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
