// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { disposeRoot } from "@dotli/ui/mount/root";
import {
  ensureOverlays,
  resetOverlayLoaderForTests,
} from "@dotli/ui/overlays/load";
import { resetModalsForTests } from "@dotli/ui/state/modals";
import { resetToastsForTests } from "@dotli/ui/state/toasts";
import { settle } from "./solid";

/** Wait until the lazily loaded overlays root has mounted and rendered. */
export async function overlaysReady(): Promise<void> {
  await ensureOverlays();
  await settle();
}

/** Unmount the overlays root and forget queued dialogs and toasts. */
export function resetOverlays(): void {
  disposeRoot("overlays");
  resetOverlayLoaderForTests();
  resetModalsForTests();
  resetToastsForTests();
  document.getElementById("overlay-root")?.remove();
}
