// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded overlays chunk. Only overlays/load.ts imports it.

import { ensureOverlayRoot } from "../../mount/overlay-root";
import { mountRoot } from "../../mount/root";
import { ModalOutlet } from "./ModalOutlet";
import { ToastStack } from "./ToastStack";

/**
 * Mount the toast and modal trees as the "overlays" root. `onBroken` runs
 * once the root broke and was disposed, so the loader can settle the queued
 * work (see `overlays/load.ts`).
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
    { onBroken },
  );
}
