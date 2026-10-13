// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sandbox draws itself: its toasts and dialogs, the error page, the retry screen and the password dialog.
// Loaded through src/lazy.ts the first time something needs it, so a product that loads never fetches it.

import { ensureOverlayRoot, mountRoot, Overlays } from '@dotli/ui';

export { showError } from '@dotli/ui';
export { passwordPromptDialog } from './password-dialog.js';
export { showRetryScreen } from './retry-screen.js';

/** Mounts the toasts and dialogs, in a container a full-page screen keeps. */
export function mountOverlays(): void {
  const root = ensureOverlayRoot();
  root.dataset['overlays'] = '';
  mountRoot('overlays', root, () => <Overlays />);
}
