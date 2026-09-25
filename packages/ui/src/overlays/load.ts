// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid overlays chunk on first use, so neither app's startup
// bundle carries Solid. Everything here is Solid-free: it writes the stores
// and imports the chunk dynamically.

import { captureException } from "@dotli/metrics/sentry";
import {
  failAllModals,
  openModal,
  type ModalOutcome,
  type ModalView,
} from "../state/modals";
import {
  clearToasts,
  pushToast,
  toastsStore,
  type ToastInput,
} from "../state/toasts";

const PREFETCH_FALLBACK_MS = 2000;

let loading: Promise<void> | null = null;

/**
 * When the chunk cannot load: action toasts ("Reload") become a native
 * confirm, other toasts are dropped unseen, and dialogs settle with their
 * fallback result so no caller waits forever.
 */
function fallBack(): void {
  for (const toast of toastsStore.get().items) {
    if (
      toast.action !== undefined &&
      !toast.leaving &&
      window.confirm(`${toast.label}\n\n${toast.text}`)
    ) {
      toast.action.onClick();
    }
  }
  clearToasts();
  failAllModals();
}

/** Import and mount the overlays root once. Never rejects. */
export function ensureOverlays(): Promise<void> {
  loading ??= import("../components/overlays/mount")
    .then(({ mountOverlays }) => {
      mountOverlays();
    })
    .catch((err: unknown) => {
      loading = null;
      captureException(err, { kind: "overlays_load_error" });
      fallBack();
    });
  return loading;
}

/** Load the overlays when the browser is idle, before anything needs them. */
export function prefetchOverlays(): void {
  const run = (): void => {
    void ensureOverlays();
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run);
  } else {
    setTimeout(run, PREFETCH_FALLBACK_MS);
  }
}

/** Queue a dialog and make sure the overlays are there to show it. */
export function presentModal<R extends string>(
  view: ModalView<R>,
  signal?: AbortSignal,
): Promise<ModalOutcome<R>> {
  const outcome = openModal(view, signal);
  if (signal?.aborted !== true) {
    void ensureOverlays();
  }
  return outcome;
}

/** Queue a toast and make sure the overlays are there to show it. */
export function presentToast(input: ToastInput): void {
  pushToast(input);
  void ensureOverlays();
}

/** Tests only. */
export function resetOverlayLoaderForTests(): void {
  loading = null;
}
