// Push-notification callback: mirrors the legacy
// `container.handlePushNotification` body — log the request and forward to
// `showPushNotification({ text, deeplink, label })`.

import type { WasmHostCallbacks } from "@truapi/host-shared";
import { log } from "@dotli/shared/log";
import { showNotification } from "../notification";

export function createPushNotification(
  label: string,
): WasmHostCallbacks["pushNotification"] {
  return ({ text, deeplink }) => {
    log.warn(`[${label}] Push notification:`, { text, deeplink });
    showNotification({ text, deeplink, label });
  };
}
