// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded overlays chunk. Only overlays/load.ts imports it.

import { ensureOverlayRoot } from "../../mount/overlay-root";
import { mountRoot } from "../../mount/root";
import { failAllModals } from "../../state/modals";
import { clearToasts } from "../../state/toasts";
import { ModalOutlet } from "./ModalOutlet";
import { ToastStack } from "./ToastStack";

export function mountOverlays(): () => void {
  return mountRoot(
    "overlays",
    ensureOverlayRoot(),
    () => (
      <>
        <ToastStack />
        <ModalOutlet />
      </>
    ),
    {
      // A render error must not leave a permission or signing promise hanging.
      onError: () => {
        failAllModals();
        clearToasts();
      },
    },
  );
}
