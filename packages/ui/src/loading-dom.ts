// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Interim: draws the loading store into the static `.loading` markup from
// apps/host/index.html, until a Solid island renders the store instead.

import {
  getLoadingState,
  loadingStore,
  type LoadingState,
} from "./state/loading";

/** Keep the static loading markup in step with the loading store. */
export function renderLoadingDom(): void {
  // Starts from the store's initial value, which the static markup paints, so
  // only a field that changed is written. Rewriting an unchanged live region
  // could make a screen reader announce it again.
  let shown: LoadingState = getLoadingState();
  loadingStore.subscribe(() => {
    const next = getLoadingState();
    const prev = shown;
    shown = next;
    const byId = (id: string): HTMLElement | null =>
      document.getElementById(id);

    if (next.progress !== prev.progress) {
      const fill = byId("loading-progress-fill");
      if (fill !== null) {
        fill.style.width = `${String(next.progress)}%`;
      }
      const pct = byId("loading-progress-pct");
      if (pct !== null) {
        pct.textContent = `${String(Math.round(next.progress))}%`;
      }
      // The bar itself carries no value for a screen reader, so the wrapper does.
      byId("loading-progress")?.setAttribute(
        "aria-valuenow",
        String(Math.round(next.progress)),
      );
    }

    const status = byId("status");
    if (status !== null) {
      if (next.statusText !== prev.statusText) {
        status.textContent = next.statusText;
      }
      if (next.statusOpacity !== prev.statusOpacity) {
        status.style.opacity = String(next.statusOpacity);
      }
    }

    if (next.srText !== prev.srText) {
      const announce = byId("status-sr");
      if (announce !== null) {
        announce.textContent = next.srText;
      }
    }

    if (next.warning !== prev.warning) {
      const row = byId("loading-warning");
      const text = byId("loading-warning-text");
      if (row !== null && text !== null) {
        text.textContent = next.warning ?? "";
        row.classList.toggle("visible", next.warning !== null);
      }
    }

    if (next.phase !== prev.phase) {
      const loading = document.querySelector<HTMLElement>("#app > .loading");
      if (next.phase === "dismissing" && loading !== null) {
        loading.style.transition = "opacity 0.3s ease";
        loading.style.opacity = "0";
        loading.style.pointerEvents = "none";
      } else if (next.phase === "gone") {
        loading?.remove();
      }
    }
  });
}
