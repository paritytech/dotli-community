// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { disposeAppRoot } from '../../src/mount/app-roots.js';
import { ensureOverlays, resetOverlayLoaderForTests } from '../../src/overlays/load.js';
import { resetModalsForTests } from '../../src/state/modals.js';
import { resetToastsForTests } from '../../src/state/toasts.js';
import { settle } from './solid.js';

export async function overlaysReady(): Promise<void> {
  await ensureOverlays();
  await settle();
}

export function resetOverlays(): void {
  disposeAppRoot('overlays');
  resetOverlayLoaderForTests();
  resetModalsForTests();
  resetToastsForTests();
  document.getElementById('overlay-root')?.remove();
}

export function footerVariants(): [string, string | undefined][] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="signing-modal-footer"] button'),
    (button): [string, string | undefined] => [button.textContent, button.dataset['variant']],
  );
}
