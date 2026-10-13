// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid overlays chunk on first use, so neither app's startup
// bundle carries Solid. Nothing here imports Solid: it writes the stores
// and leaves importing the chunk to the `load` it is given.

import {
  clearToasts,
  createLazyRoot,
  failAllModals,
  openModal,
  pushToast,
  toastsStore,
  type IdleScheduler,
  type ModalOptions,
  type ModalOutcome,
  type ModalView,
  type ReportFailure,
  type ToastInput,
} from '@dotli/ui-core';

export interface OverlaysDeps {
  /** Imports and mounts the overlays root. Passes `onBroken` on as mountRoot's option of that name. */
  load: (onBroken: () => void) => Promise<unknown>;
  /** Offers an action toast's action when there are no overlays to show it in. */
  confirm: (text: string) => boolean;
  /** Takes a chunk that failed to load and a throw from a toast's `onDismiss`. */
  report: ReportFailure;
  /** Where prefetch finds the browser's idle callbacks. The page's own by default. */
  idle?: IdleScheduler | undefined;
}

/** Queues a dialog and settles with the user's answer. */
export type PresentModal = <R extends string>(
  view: ModalView<R>,
  signal?: AbortSignal,
  options?: ModalOptions,
) => Promise<ModalOutcome<R>>;

export interface Overlays {
  /** Import and mount the overlays root once. Never rejects. */
  ensure: () => Promise<void>;
  /** Load the overlays when the browser is idle, before anything needs them. */
  prefetch: () => void;
  /** Queue a dialog and make sure the overlays are there to show it. */
  presentModal: PresentModal;
  /** Queue a toast and make sure the overlays are there to show it. */
  presentToast: (input: ToastInput) => void;
  /** Tests only: forget the mounted root. */
  reset: () => void;
}

/**
 * The overlays over the page's toast and dialog stores. When the chunk cannot load, or the mounted root later throws
 * while rendering, action toasts ("Reload") become a confirm, other toasts are dropped unseen, and dialogs settle with
 * their fallback result so no caller waits forever.
 */
export function createOverlays({ load, confirm, report, idle }: OverlaysDeps): Overlays {
  const fallBack = (): void => {
    for (const toast of toastsStore.get().items) {
      if (toast.action !== undefined && !toast.leaving && confirm(`${toast.label}\n\n${toast.text}`)) {
        toast.action.onClick();
      }
    }
    clearToasts();
    failAllModals();
  };
  const root = createLazyRoot({ load, root: 'overlays', onFailure: fallBack, report, idle });
  return {
    ensure: root.ensure,
    prefetch: root.prefetch,
    presentModal: (view, signal, options) => {
      const outcome = openModal(view, signal, options);
      if (signal?.aborted !== true) {
        void root.ensure();
      }
      return outcome;
    },
    presentToast: input => {
      pushToast(input, report);
      void root.ensure();
    },
    reset: root.reset,
  };
}
