// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid landing page chunk, so the host's startup bundle does not
// carry it. Everything here is Solid-free: it prepares `#app` and imports the
// chunk dynamically.

import { captureException } from "@dotli/metrics/sentry";
import { disposeAppRoot } from "../mount/app-roots";
import { showError } from "../ui";

let showing: Promise<void> | null = null;

/** The host's "reload" error page, for a landing page that cannot show. */
function showBroken(): void {
  showError(
    "Something went wrong on our side",
    "This page didn't load properly. Reloading usually fixes it.",
    {
      label: "Reload",
      onClick: () => {
        window.location.reload();
      },
    },
  );
}

/**
 * Show the landing page (no name to resolve) once, in a new `#app-view`, as
 * the `"page"` app root. The loading screen stays up until the landing chunk
 * has loaded, so the page is never blank while it downloads. If the chunk
 * cannot load, the error is reported and the error page offers a reload.
 * Never rejects.
 */
export function showLanding(): Promise<void> {
  showing ??= import("../components/landing/mount")
    .then(({ mountLanding }) => {
      const app = document.getElementById("app") ?? document.body;
      const topbar = document.getElementById("topbar");
      if (topbar) {
        topbar.style.display = "none";
      }
      app.style.marginTop = "0";
      app.style.minHeight = "100dvh";
      // The landing page replaces the loading screen, island and all.
      disposeAppRoot("loading");
      const view = document.createElement("div");
      view.id = "app-view";
      // Whatever else `#app` holds goes too, as when the page was written
      // over it.
      app.replaceChildren(view);
      mountLanding(view, showBroken);
    })
    .catch((err: unknown) => {
      captureException(err, { kind: "landing_load_error" });
      showBroken();
    });
  return showing;
}
