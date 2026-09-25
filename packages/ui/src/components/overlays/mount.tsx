// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded overlays chunk. Only overlays/load.ts imports it.

import { ensureOverlayRoot } from "../../mount/overlay-root";
import { mountRoot } from "../../mount/root";
import { ModalOutlet } from "./ModalOutlet";
import { ToastStack } from "./ToastStack";

/**
 * Mount the toast and modal trees as the "overlays" root. `onBroken` runs
 * after a render error has been reported, so the loader can recover the
 * root (see `overlays/load.ts`, which is where settling the queued work now
 * happens, since this file must not decide it alone).
 */
export function mountOverlays(onBroken: () => void): () => void {
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
      onError: onBroken,
    },
  );
}
