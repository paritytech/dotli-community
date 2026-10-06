// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { disposeAppRoot } from '../../src/mount/app-roots.js';
import { ensureOverlays, resetOverlayLoaderForTests } from '../../src/overlays/load.js';
import { resetModalsForTests } from '../../src/state/modals.js';
import { resetToastsForTests } from '../../src/state/toasts.js';
import { settle } from './solid.js';

/** Wait until the lazily loaded overlays root has mounted and rendered. */
export async function overlaysReady(): Promise<void> {
  await ensureOverlays();
  await settle();
}

/** Unmount the overlays root and forget queued dialogs and toasts. */
export function resetOverlays(): void {
  disposeAppRoot('overlays');
  resetOverlayLoaderForTests();
  resetModalsForTests();
  resetToastsForTests();
  document.getElementById('overlay-root')?.remove();
}

/** Each footer answer of the open dialog: its label and how it is drawn (`data-variant`). */
export function footerVariants(): [string, string | undefined][] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="signing-modal-footer"] button'),
    (button): [string, string | undefined] => [button.textContent, button.dataset['variant']],
  );
}
