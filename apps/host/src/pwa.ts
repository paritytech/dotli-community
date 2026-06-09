// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// PWA registration for the host shell.
//
// Uses workbox-window so updates are prompted, not auto-applied:
//   1. Register /host-sw.js
//   2. On `waiting`, surface a notification asking the user to reload
//   3. On confirm, message the waiting SW with SKIP_WAITING and reload
//      once the new SW takes control
//   4. Poll for updates every 15 min and whenever a hidden tab returns
//
// Scope is the host origin only. The protocol iframe (host.dot.li) and
// the app iframe (*.app.dot.li) are cross-origin and untouched.

import { Workbox } from "workbox-window";
import { showNotification } from "@dotli/ui/notification";
import { log } from "@dotli/shared/log";

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

if ("serviceWorker" in navigator) {
  const wb = new Workbox("/host-sw.js");

  wb.addEventListener("waiting", () => {
    showNotification({
      label: "Update available",
      text: "A new version of dot.li is ready. Reload to apply.",
      dismissMs: 0,
      action: {
        label: "Reload",
        onClick: () => {
          // Reload once the new SW is in control to avoid serving a mix of
          // old and new chunks during the swap.
          wb.addEventListener("controlling", () => {
            window.location.reload();
          });
          wb.messageSkipWaiting();
        },
      },
    });
  });

  void wb
    .register()
    .then((registration) => {
      if (!registration) {
        return;
      }
      setInterval(() => {
        if (navigator.onLine) {
          void registration.update();
        }
      }, UPDATE_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && navigator.onLine) {
          void registration.update();
        }
      });
    })
    .catch((err: unknown) => {
      log.warn(`[dot.li] SW registration failed: ${String(err)}`);
    });
}
