// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { disposeAppRoot } from "@dotli/ui/mount/app-roots";
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
  disposeAppRoot("overlays");
  resetOverlayLoaderForTests();
  resetModalsForTests();
  resetToastsForTests();
  document.getElementById("overlay-root")?.remove();
}
