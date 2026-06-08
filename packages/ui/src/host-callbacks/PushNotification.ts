// Push-notification callback. The Rust core passes the typed request, and
// this adapter returns a stable host-side id for cancel support.

import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { log } from "@dotli/shared/log";
import { showNotification } from "../notification";

let nextNotificationId = 0;

export function createNotificationAdapters(
  label: string,
): Pick<HostCallbacks, "pushNotification" | "cancelNotification"> {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const pushNotification: HostCallbacks["pushNotification"] = async ({
    text,
    deeplink,
    scheduledAt,
  }) => {
    const id = ++nextNotificationId;
    log.warn(`[${label}] Push notification:`, {
      id,
      text,
      deeplink,
      scheduledAt,
    });
    const fire = (): void => showNotification({ text, deeplink, label });
    const scheduledMs =
      scheduledAt === undefined ? undefined : Number(scheduledAt);
    const delay =
      scheduledMs === undefined ? 0 : Math.max(0, scheduledMs - Date.now());
    if (delay === 0) {
      fire();
    } else {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          fire();
        }, delay),
      );
    }
    return { id };
  };

  const cancelNotification: HostCallbacks["cancelNotification"] = async (
    id,
  ) => {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  };

  return { pushNotification, cancelNotification };
}
