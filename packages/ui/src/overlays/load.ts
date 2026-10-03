// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid overlays chunk on first use, so neither app's startup
// bundle carries Solid. Everything here is Solid-free: it writes the stores
// and imports the chunk dynamically.

import { createLazyRoot } from '../mount/lazy-root.js';
import { failAllModals, openModal, type ModalOutcome, type ModalView } from '../state/modals.js';
import { clearToasts, pushToast, toastsStore, type ToastInput } from '../state/toasts.js';

/**
 * When the chunk cannot load, or the mounted root later throws while
 * rendering: action toasts ("Reload") become a native confirm, other toasts
 * are dropped unseen, and dialogs settle with their fallback result so no
 * caller waits forever.
 */
function fallBack(): void {
  for (const toast of toastsStore.get().items) {
    if (toast.action !== undefined && !toast.leaving && window.confirm(`${toast.label}\n\n${toast.text}`)) {
      toast.action.onClick();
    }
  }
  clearToasts();
  failAllModals();
}

const overlays = createLazyRoot({
  load: onBroken => import('../components/overlays/mount.js').then(({ mountOverlays }) => mountOverlays(onBroken)),
  errorKind: 'overlays_load_error',
  onFailure: fallBack,
});

/** Import and mount the overlays root once. Never rejects. */
export const ensureOverlays = overlays.ensure;

/** Load the overlays when the browser is idle, before anything needs them. */
export const prefetchOverlays = overlays.prefetch;

/** Queue a dialog and make sure the overlays are there to show it. */
export function presentModal<R extends string>(view: ModalView<R>, signal?: AbortSignal): Promise<ModalOutcome<R>> {
  const outcome = openModal(view, signal);
  if (signal?.aborted !== true) {
    void ensureOverlays();
  }
  return outcome;
}

/** Queue a toast and make sure the overlays are there to show it. */
export function presentToast(input: ToastInput): number {
  const id = pushToast(input);
  void ensureOverlays();
  return id;
}

/** Tests only. */
export const resetOverlayLoaderForTests = overlays.reset;
